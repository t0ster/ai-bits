"""One Psycopg pool shared by SQLAlchemy and LangGraph in each process."""

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from lib.config import settings

from .tables import metadata


async def _reset_connection(connection: AsyncConnection) -> None:
    """Restore checkpoint autocommit after SQLAlchemy's transactional checkout."""
    await connection.set_autocommit(True)


pool = AsyncConnectionPool(
    conninfo=settings.database_url,
    open=False,
    close_returns=True,
    kwargs={"autocommit": True, "prepare_threshold": 0},
    reset=_reset_connection,
)
engine = create_async_engine(
    "postgresql+psycopg://",
    poolclass=NullPool,
    async_creator=pool.getconn,
    isolation_level="READ COMMITTED",
)


def create_checkpointer() -> AsyncPostgresSaver:
    """Use the shared pool; the saver selects dict rows on its own cursors."""
    # SQLAlchemy requires tuple rows. LangGraph overrides each cursor's row factory,
    # but its pool annotation unnecessarily requires connection-level dict rows.
    return AsyncPostgresSaver(pool)  # pyright: ignore[reportArgumentType]


async def setup_database() -> None:
    """Create missing tables and indexes; existing columns require migrations."""
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
        for table in metadata.sorted_tables:
            for index in table.indexes:
                await connection.run_sync(index.create, checkfirst=True)
    await create_checkpointer().setup()
