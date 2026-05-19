"""
Shared FastAPI dependencies.
"""

from fastapi import HTTPException, Request


_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def require_loopback(request: Request) -> None:
    """Reject any request whose `client.host` is not a loopback address.

    Use as a router-level dependency:
        router = APIRouter(dependencies=[Depends(require_loopback)])
    """
    host = request.client.host if request.client else None
    if host not in _LOOPBACK_HOSTS:
        raise HTTPException(status_code=403, detail="loopback origin required")
