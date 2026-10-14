"""Download NASA e-book PDFs, EPUBs, and covers into data/nasa/<area>/<section>/<book>/.

Each book folder must already contain metadata.json; its `files` and `cover`
entries name the files to download. Sources are discovered from NASA's e-book
listing pages. Existing valid files are skipped, so reruns resume.

Usage:
    uv run cli/download_nasa_books.py [--format {all,pdf,epub}] [--only SUBSTRING]
        [--limit N] [--concurrency N]

--format picks which documents to download (covers are always fetched for the
selected books); --limit downloads at most N books that are still incomplete after
--only/--format filtering. Books whose selected files are all present and valid are
skipped and never count toward the limit.
"""

import argparse
import asyncio
import json
import re
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import final
from urllib.parse import urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup, Tag

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "nasa"
LISTING_PAGES = {
    "aeronautics": "https://www.nasa.gov/aeronautics-e-books",
    "science": "https://science.nasa.gov/multimedia/science-e-books",
}
USER_AGENT = "Mozilla/5.0 (nasa-rag e-book downloader)"
DOCUMENT_URL = re.compile(r"\.(pdf|epub)$", re.IGNORECASE)


@dataclass(frozen=True)
class ListingEntry:
    """One book card on a NASA e-book listing page."""

    area: str
    section: str
    title: str
    link_text: str
    page_url: str
    cover_url: str | None


def normalize(text: str) -> str:
    """Compare titles across folder names, headings, and link labels."""
    text = text.casefold().replace("’", "'")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def url_path(url: str) -> str:
    """Drop query strings such as NASA's cache-busting `emrc` parameter."""
    return urlsplit(url)._replace(query="", fragment="").geturl()


async def fetch_html(client: httpx.AsyncClient, url: str) -> BeautifulSoup:
    response = await client.get(url)
    _ = response.raise_for_status()
    return BeautifulSoup(response.text, "html.parser")


def card_for(heading: Tag) -> Tag:
    """Return the nearest ancestor of a card heading that holds its link."""
    card = heading
    for _ in range(6):
        if card.parent is None:
            break
        card = card.parent
        if card.find("a", href=True):
            return card
    return card


async def read_listing(
    client: httpx.AsyncClient, area: str, url: str
) -> list[ListingEntry]:
    main = (await fetch_html(client, url)).find("main")
    if not isinstance(main, Tag):
        raise TypeError(f"Listing page has no <main>: {url}")
    entries: list[ListingEntry] = []
    section = ""
    for heading in main.find_all(["h2", "h3"]):
        if heading.name == "h2":
            section = heading.get_text(" ", strip=True)
            continue
        card = card_for(heading)
        link = card.find("a", href=True)
        if not isinstance(link, Tag):
            continue
        image_card = card if card.find("img") else card.parent
        image = image_card.find("img") if isinstance(image_card, Tag) else None
        cover_src = image.get("src") if isinstance(image, Tag) else None
        entries.append(
            ListingEntry(
                area=area,
                section=section,
                title=heading.get_text(" ", strip=True),
                link_text=link.get_text(" ", strip=True),
                page_url=urljoin(url, str(link["href"])),
                # Listing images carry resize queries; the bare URL is full size.
                cover_url=url_path(urljoin(url, str(cover_src))) if cover_src else None,
            )
        )
    return entries


def find_entry(book_dir: Path, entries: list[ListingEntry]) -> ListingEntry:
    """Match a book folder to its listing card by area, section, and title."""
    area, section = book_dir.relative_to(DATA_DIR).parts[:2]
    name = normalize(book_dir.name)
    matches = [
        entry
        for entry in entries
        if entry.area == area
        and normalize(entry.section) == normalize(section)
        and name
        in (
            normalize(entry.title),
            normalize(re.sub(r"^View\s+", "", entry.link_text)),
        )
    ]
    if len(matches) != 1:
        raise LookupError(f"Expected one listing entry, found {len(matches)}")
    return matches[0]


@dataclass(frozen=True)
class BookPage:
    """Download candidates found on a book's page."""

    links: list[str]
    after_title: list[str]
    cover_urls: list[str]


async def read_book_page(client: httpx.AsyncClient, entry: ListingEntry) -> BookPage:
    """Collect document links in page order, those after the book title, and covers."""
    card_covers = [entry.cover_url] if entry.cover_url else []
    if DOCUMENT_URL.search(url_path(entry.page_url)):
        return BookPage([entry.page_url], [entry.page_url], card_covers)
    page = await fetch_html(client, entry.page_url)
    og_image = page.find("meta", property="og:image")
    page_covers = (
        [urljoin(entry.page_url, str(og_image["content"]))]
        if isinstance(og_image, Tag) and og_image.get("content")
        else []
    )
    root = page.find("main") or page.body or page
    title = normalize(entry.title)
    links: list[str] = []
    after_title: list[str] = []
    title_seen = False
    for node in root.descendants:
        if isinstance(node, Tag) and node.name == "a" and node.get("href"):
            url = urljoin(entry.page_url, str(node["href"]))
            if DOCUMENT_URL.search(url_path(url)):
                links.append(url)
                if title_seen:
                    after_title.append(url)
        elif not isinstance(node, Tag) and normalize(str(node)) == title:
            # Pages listing several books name each one right before its link.
            title_seen = True
    return BookPage(
        unique_by_path(links),
        unique_by_path(after_title),
        rank_covers(page_covers + card_covers),
    )


def rank_covers(urls: list[str]) -> list[str]:
    """Order cover candidates: named covers first, then the page image, then the card.

    Listing cards often show photos and page images are sometimes generic
    thumbnails (`cq5dam.*`), so neither source is a cover on its own.
    """
    candidates = [url for url in unique_by_path(urls) if "cq5dam" not in url_path(url)]

    def rank(url: str) -> tuple[bool, bool]:
        name = url_path(url).rsplit("/", 1)[-1].lower()
        return ("cover" not in name, name.endswith(".webp"))

    return sorted(candidates, key=rank)


def unique_by_path(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url_path(url) not in seen:
            seen.add(url_path(url))
            unique.append(url)
    return unique


def candidates_for(
    extension: str, links: list[str], after_title: list[str]
) -> list[str]:
    """Prefer the only link of a type; otherwise the links following the title."""
    matching = [url for url in links if url_path(url).lower().endswith(extension)]
    if len(matching) <= 1:
        return matching
    near_title = [
        url for url in after_title if url_path(url).lower().endswith(extension)
    ]
    return near_title or matching


def is_valid_pdf(path: Path) -> bool:
    with path.open("rb") as file:
        if file.read(5) != b"%PDF-":
            return False
        _ = file.seek(max(path.stat().st_size - 2048, 0))
        return b"%%EOF" in file.read()


def is_valid_epub(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as archive:
            return archive.read("mimetype").strip() == b"application/epub+zip"
    except zipfile.BadZipFile, KeyError:
        return False


def is_valid_image(path: Path) -> bool:
    with path.open("rb") as file:
        header = file.read(12)
    return header.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n")) or (
        header[:4] == b"RIFF" and header[8:12] == b"WEBP"
    )


def is_valid(path: Path, suffix: str) -> bool:
    suffix = suffix.lower()
    if suffix == ".pdf":
        return is_valid_pdf(path)
    if suffix == ".epub":
        return is_valid_epub(path)
    return is_valid_image(path)


@final
class EventLog:
    """Print structured events as JSON Lines on stdout and count failures.

    Every line has a `kind`:
    - `started`: a file download began (`book`, `file`, `url`, `total_bytes`).
    - `file`: a file's outcome (`status` downloaded, skipped, or failed).
    - `book`: a whole book failed before any file was attempted.
    - `summary`: final counts.
    """

    def __init__(self) -> None:
        self.failures = 0

    def emit(self, kind: str, **fields: object) -> None:
        # Runs on the event loop thread between awaits, so no lock is needed.
        if fields.get("status") == "failed":
            self.failures += 1
        print(json.dumps({"kind": kind, **fields}, ensure_ascii=False), flush=True)


async def download(
    client: httpx.AsyncClient, url: str, target: Path, book: str, log: EventLog
) -> None:
    """Stream to a partial file and keep it only when valid."""
    partial = target.with_name(target.name + ".part")
    try:
        async with client.stream("GET", url) as response:
            _ = response.raise_for_status()
            length = response.headers.get("content-length")
            total = int(length) if length and length.isdigit() else None
            log.emit("started", book=book, file=target.name, url=url, total_bytes=total)
            with partial.open("wb") as file:
                async for chunk in response.aiter_bytes(1 << 20):
                    _ = file.write(chunk)
        if not is_valid(partial, target.suffix):
            raise ValueError(f"Downloaded file is not a valid {target.suffix}")
        _ = partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)


async def fetch_file(
    client: httpx.AsyncClient, target: Path, urls: list[str], log: EventLog
) -> None:
    book = str(target.parent.relative_to(DATA_DIR))
    if target.exists() and is_valid(target, target.suffix):
        log.emit("file", book=book, file=target.name, status="skipped")
        return
    if not urls:
        log.emit(
            "file", book=book, file=target.name, status="failed", error="no source"
        )
        return
    errors: list[str] = []
    for url in urls:
        try:
            await download(client, url, target, book, log)
        except (httpx.HTTPError, OSError, ValueError) as error:
            errors.append(f"{url}: {type(error).__name__}: {error}")
            continue
        log.emit("file", book=book, file=target.name, status="downloaded", url=url)
        return
    log.emit("file", book=book, file=target.name, status="failed", errors=errors)


def selected_files(metadata: dict[str, object], document_format: str) -> list[str]:
    """Return the metadata `files` matching --format."""
    files = metadata["files"]
    assert isinstance(files, list)
    return [
        str(name)
        for name in files
        if document_format == "all"
        or Path(str(name)).suffix.lower() == f".{document_format}"
    ]


async def download_book(
    client: httpx.AsyncClient,
    book_dir: Path,
    entries: list[ListingEntry],
    document_format: str,
    log: EventLog,
) -> None:
    metadata = json.loads((book_dir / "metadata.json").read_text())
    try:
        entry = find_entry(book_dir, entries)
        page = await read_book_page(client, entry)
    except (LookupError, httpx.HTTPError, TypeError, ValueError) as error:
        book = str(book_dir.relative_to(DATA_DIR))
        log.emit(
            "book", book=book, status="failed", error=f"{type(error).__name__}: {error}"
        )
        return
    for name in selected_files(metadata, document_format):
        extension = Path(name).suffix.lower()
        urls = candidates_for(extension, page.links, page.after_title)
        await fetch_file(client, book_dir / name, urls, log)
    if metadata.get("cover"):
        await fetch_file(client, book_dir / metadata["cover"], page.cover_urls, log)


def book_dirs(only: str | None, document_format: str) -> Iterator[Path]:
    """Yield book folders matching --only that have a document in --format."""
    for metadata_path in sorted(DATA_DIR.rglob("metadata.json")):
        book_dir = metadata_path.parent
        if only is not None and only.casefold() not in str(book_dir).casefold():
            continue
        if selected_files(json.loads(metadata_path.read_text()), document_format):
            yield book_dir


def is_complete(book_dir: Path, document_format: str) -> bool:
    """Whether every selected document and the cover are present and valid."""
    metadata = json.loads((book_dir / "metadata.json").read_text())
    names = selected_files(metadata, document_format)
    if metadata.get("cover"):
        names.append(str(metadata["cover"]))
    return all(
        (book_dir / name).exists() and is_valid(book_dir / name, Path(name).suffix)
        for name in names
    )


def positive_integer(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("Expected a positive integer")
    return number


async def download_books(
    books: list[Path], document_format: str, concurrency: int, log: EventLog
) -> None:
    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        timeout=httpx.Timeout(60, read=300),
    ) as client:
        listings = [
            read_listing(client, area, url) for area, url in LISTING_PAGES.items()
        ]
        entries = [
            entry for listing in await asyncio.gather(*listings) for entry in listing
        ]
        slots = asyncio.Semaphore(concurrency)

        async def limited(book: Path) -> None:
            async with slots:
                await download_book(client, book, entries, document_format, log)

        # TaskGroup cancels remaining books and re-raises on unexpected errors.
        async with asyncio.TaskGroup() as group:
            for book in books:
                _ = group.create_task(limited(book))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download NASA e-book PDFs, EPUBs, and covers."
    )
    _ = parser.add_argument(
        "--format",
        choices=("all", "pdf", "epub"),
        default="all",
        help="Documents to download; covers are always fetched for selected books",
    )
    _ = parser.add_argument("--only", help="Only books whose path contains this text")
    _ = parser.add_argument(
        "--limit",
        type=positive_integer,
        help="Download at most N incomplete books after --only/--format filtering",
    )
    _ = parser.add_argument("--concurrency", type=positive_integer, default=4)
    args = parser.parse_args()

    selected = list(book_dirs(args.only, args.format))
    pending = [book for book in selected if not is_complete(book, args.format)]
    books = pending[: args.limit]
    log = EventLog()
    asyncio.run(download_books(books, args.format, args.concurrency, log))
    log.emit(
        "summary",
        complete_books=len(selected) - len(pending),
        incomplete_books=len(pending),
        processed_books=len(books),
        failures=log.failures,
    )
    return 1 if log.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
