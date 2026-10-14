# SPDX-FileCopyrightText: The Docling Contributors
# SPDX-License-Identifier: MIT
"""Text-only EPUB backport from Docling v2.133.0, backend/epub_backend.py.

Source: https://github.com/docling-project/docling/blob/b0315ea356298e4659c9727e9f5191dd2001860a/docling/backend/epub_backend.py

Local adaptations for Docling 2.73.1:
- Use HTML conversion instead of the unavailable EPUB format/options.
- Omit optional image extraction; never fetch local or remote images.
- Apply upstream archive limits before reading content, not only image extraction.
- Fail on unreadable spine entries instead of silently skipping chapters.
- Retain URI decoding, path normalization, UTF-16 and internal-link fixes.

MIT License

Copyright The Docling Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

import codecs
import posixpath
import re
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZipFile

import defusedxml.ElementTree as ET
from docling.datamodel.backend_options import HTMLBackendOptions
from docling.datamodel.base_models import InputFormat
from docling.document_converter import DocumentConverter, HTMLFormatOption
from docling.utils.utils import create_file_hash
from docling_core.types.doc.common.origin import DocumentOrigin
from docling_core.types.doc.document import DoclingDocument
from docling_core.types.io import DocumentStream


def convert_epub_document(path: Path) -> DoclingDocument:
    """Convert EPUB spine content in reading order; EPUB has no fixed PDF pages."""
    with ZipFile(path) as archive:
        members = archive.infolist()
        # Limits copied from upstream EpubBackendOptions.
        if (
            len(members) > 1000
            or any(member.file_size > 10 * 1024 * 1024 for member in members)
            or sum(member.file_size for member in members) > 100 * 1024 * 1024
        ):
            raise ValueError(
                "EPUB conversion failed: archive exceeds size/count limits"
            )

        container = ET.fromstring(archive.read("META-INF/container.xml"))
        rootfile = container.find(
            ".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile"
        )
        opf_path = rootfile.get("full-path") if rootfile is not None else None
        if not opf_path:
            raise ValueError("EPUB conversion failed: missing rootfile path")

        package = ET.fromstring(archive.read(opf_path))
        namespaces = {"opf": "http://www.idpf.org/2007/opf"}
        spine = package.find(".//opf:spine", namespaces)
        manifest = package.find(".//opf:manifest", namespaces)
        if spine is None or manifest is None:
            raise ValueError("EPUB conversion failed: missing spine or manifest")

        manifest_map = {}
        for item in manifest.findall("opf:item", namespaces):
            item_id, href = item.get("id"), item.get("href")
            if item_id and href:
                manifest_map[item_id] = unquote(href)

        combined_html_parts = [
            '<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>'
        ]
        for itemref in spine.findall("opf:itemref", namespaces):
            idref = itemref.get("idref")
            if not idref or idref not in manifest_map:
                raise ValueError("EPUB conversion failed: unresolved spine entry")
            content_file = posixpath.normpath(
                posixpath.join(posixpath.dirname(opf_path), manifest_map[idref])
            )
            data = archive.read(content_file)
            encoding = (
                "utf-16"
                if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))
                else "utf-8"
            )
            xhtml_text = data.decode(encoding)
            body_match = re.search(
                r"<body[^>]*>(.*?)</body>", xhtml_text, re.DOTALL | re.IGNORECASE
            )
            body_content = body_match.group(1) if body_match else xhtml_text
            # Chapters are merged: cross-file links become local anchors.
            body_content = re.sub(
                r'href="(?!\w+:|//)([^"]*\.(?:xhtml|xht|html?))(#[^"]*)"',
                r'href="\2"',
                body_content,
            )
            combined_html_parts.append(body_content)
        if len(combined_html_parts) == 1:
            raise ValueError("EPUB conversion failed: empty spine")
        combined_html_parts.append("</body></html>")

    converter = DocumentConverter(
        allowed_formats=[InputFormat.HTML],
        format_options={
            InputFormat.HTML: HTMLFormatOption(
                backend_options=HTMLBackendOptions(
                    kind="html",
                    source_uri=None,
                    fetch_images=False,
                    enable_local_fetch=False,
                    enable_remote_fetch=False,
                    infer_furniture=False,
                    add_title=False,
                )
            )
        },
    )
    with BytesIO("\n".join(combined_html_parts).encode("utf-8")) as stream:
        document = converter.convert(
            DocumentStream(name="combined.html", stream=stream)
        ).document
    document.origin = DocumentOrigin.model_validate(
        {
            "filename": path.name,
            "mimetype": "application/epub+zip",
            "binary_hash": create_file_hash(path),
        }
    )
    document.name = path.stem
    return document
