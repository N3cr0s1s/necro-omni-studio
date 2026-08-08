"""FastAPI application.

Endpoints are thin adapters: validate input, delegate to :class:`MediaService`, translate a
:class:`MediaError` into a structured HTTP response. Business logic stays in the service so it can
be tested without a client.

## Binding and trust

The server binds to loopback only and requires a shared token supplied by the parent process. It
is a plain HTTP server on the user's machine, so without a token *any* local process — including a
web page's fetch to ``127.0.0.1`` — could read arbitrary files through the media endpoints. The
token is passed to the sidecar at spawn time and is never written to disk.

## Dependency wiring

Dependency providers are module-level functions reading from ``request.app.state``, deliberately not
closures over ``create_app`` locals. This module uses PEP 563 string annotations, and FastAPI
resolves those against *module* globals — a ``Depends(local_function)`` inside an ``Annotated[...]``
would fail to resolve and silently degrade the parameter into a query field, which presents as a
puzzling 422 on every request.
"""

from __future__ import annotations

import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from . import __version__, ffmpeg
from .encoder import EncodeError, EncoderService
from .media_service import MediaError, MediaService
from .models import (
    CacheStatsModel,
    DerivedArtifactModel,
    DeriveRequest,
    ErrorModel,
    ExportStartRequest,
    ExportStatusModel,
    HealthModel,
    MediaMetadataModel,
    ProbeRequest,
    ScanRequest,
    ScanResponse,
    SegmentCapabilitiesModel,
    SegmentFrameModel,
    SegmentFramesModel,
    SegmentStartRequest,
    SegmentStatusModel,
)
from .paths import PathError, ensure_project_layout, to_relative
from .segmentation import (
    Point,
    SegmentationError,
    SegmentationService,
    SegmentJob,
    SegmentRequest,
)


class Settings:
    """Runtime configuration, supplied by the parent process at spawn."""

    def __init__(self, project_root: Path, token: str) -> None:
        self.project_root = project_root.resolve()
        self.token = token


def _check_token(request: Request, supplied: str | None) -> None:
    expected: str = request.app.state.settings.token
    # Constant-time comparison: a naive `!=` leaks the token prefix through timing to a local
    # attacker able to make many requests, which is precisely the threat model here.
    if supplied is None or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid or missing sidecar token")


def require_token(
    request: Request,
    x_nos_token: Annotated[str | None, Header()] = None,
) -> None:
    """Reject requests without the shared token in the header."""
    _check_token(request, x_nos_token)


def require_token_header_or_query(
    request: Request,
    x_nos_token: Annotated[str | None, Header()] = None,
    token: str | None = None,
) -> None:
    """Accept the token from the header *or* a query parameter.

    Used only by ``/media/file``. The renderer feeds proxies to ``<video src>`` and filmstrips to
    ``<img src>``, and neither element can send a request header — so for those the token has to
    travel in the URL. Everywhere else the header is required, because a token in a URL is easier
    to leak by accident (logs, referrers, a copied link).

    Tolerable here because the endpoint is loopback-only and the URL never leaves the renderer
    process.
    """
    _check_token(request, x_nos_token or token)


def get_encoder(request: Request) -> EncoderService:
    """Resolve the encoder service, or report that startup has not finished."""
    resolved = getattr(request.app.state, "encoder", None)
    if resolved is None:
        raise HTTPException(status_code=503, detail="sidecar is not ready")
    assert isinstance(resolved, EncoderService)
    return resolved


def get_segmenter(request: Request) -> SegmentationService:
    """Resolve the segmentation service, or report that startup has not finished."""
    resolved = getattr(request.app.state, "segmenter", None)
    if resolved is None:
        raise HTTPException(status_code=503, detail="sidecar is not ready")
    assert isinstance(resolved, SegmentationService)
    return resolved


def get_service(request: Request) -> MediaService:
    """Resolve the media service, or report that startup has not finished."""
    resolved = getattr(request.app.state, "service", None)
    if resolved is None:
        raise HTTPException(status_code=503, detail="sidecar is not ready")
    assert isinstance(resolved, MediaService)
    return resolved


Authorized = Depends(require_token)
AuthorizedUrl = Depends(require_token_header_or_query)
ServiceDep = Annotated[MediaService, Depends(get_service)]
EncoderDep = Annotated[EncoderService, Depends(get_encoder)]
SegmenterDep = Annotated[SegmentationService, Depends(get_segmenter)]


def create_app(project_root: Path, token: str | None = None) -> FastAPI:
    """Build the application for one project folder.

    A project root per process rather than a root passed per request: the path-containment
    guarantee is far easier to reason about when there is exactly one root, and switching projects
    restarts the sidecar, which also discards any accumulated decoder state.
    """
    settings = Settings(project_root, token or secrets.token_urlsafe(32))

    @asynccontextmanager
    async def lifespan(instance: FastAPI) -> AsyncIterator[None]:
        # Resolved once at startup so a missing ffmpeg is a startup failure rather than a
        # per-request mystery.
        tooling = ffmpeg.Tooling.discover()
        ensure_project_layout(settings.project_root)
        instance.state.service = MediaService(settings.project_root, tooling)
        instance.state.encoder = EncoderService(settings.project_root, tooling)
        instance.state.segmenter = SegmentationService(settings.project_root)
        instance.state.tooling = tooling
        try:
            yield
        finally:
            # Cancel anything still encoding: a half-written mp4 outliving the process is worse than
            # none, and the file would have no moov atom so it could not play anyway.
            encoder = getattr(instance.state, "encoder", None)
            if encoder is not None:
                for job in encoder.active():
                    await encoder.cancel(job)
            # Segmentation jobs hold GPU memory; leaving one running past shutdown would keep a
            # model resident with nothing left to consume its output.
            segmenter = getattr(instance.state, "segmenter", None)
            if segmenter is not None:
                for job in segmenter.active():
                    await segmenter.cancel(job)
            instance.state.service = None
            instance.state.encoder = None
            instance.state.segmenter = None

    app = FastAPI(
        title="Necro Omni Studio media sidecar",
        version=__version__,
        lifespan=lifespan,
        # No docs endpoints: this is a private API on loopback, and an unauthenticated schema
        # browser is a needless disclosure.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings

    @app.exception_handler(EncodeError)
    async def encode_error_handler(_request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, EncodeError)
        return JSONResponse(
            status_code=error.status,
            content=ErrorModel(kind=error.kind, detail=error.detail).model_dump(),
        )

    @app.exception_handler(SegmentationError)
    async def segmentation_error_handler(_request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, SegmentationError)
        return JSONResponse(
            status_code=error.status,
            content=ErrorModel(kind=error.kind, detail=error.detail).model_dump(),
        )

    @app.exception_handler(MediaError)
    async def media_error_handler(_request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, MediaError)
        return JSONResponse(
            status_code=error.status,
            content=ErrorModel(kind=error.kind, detail=error.detail).model_dump(),
        )

    @app.get("/health", response_model=HealthModel)
    async def health(request: Request) -> HealthModel:
        """Liveness and configuration echo.

        Deliberately unauthenticated: the parent process polls this to know when the port is
        listening, and it reveals nothing an attacker could not learn from the process table. It
        reports paths, never the token.
        """
        tooling = getattr(request.app.state, "tooling", None)
        return HealthModel(
            status="ok",
            version=__version__,
            project_root=str(request.app.state.settings.project_root),
            ffmpeg=tooling.ffmpeg if tooling else "",
            ffprobe=tooling.ffprobe if tooling else "",
        )

    @app.post("/media/probe", response_model=MediaMetadataModel, dependencies=[Authorized])
    async def probe(body: ProbeRequest, media: ServiceDep) -> MediaMetadataModel:
        return await media.probe(body.asset)

    @app.post("/media/derive", response_model=DerivedArtifactModel, dependencies=[Authorized])
    async def derive(body: DeriveRequest, media: ServiceDep) -> DerivedArtifactModel:
        return await media.derive(body.asset, body.spec)

    @app.get("/media/file", dependencies=[AuthorizedUrl])
    async def read_file(asset: str, media: ServiceDep) -> FileResponse:
        """Serve a project file.

        Needed because the renderer cannot read arbitrary local files: proxies feed ``<video>``
        elements and filmstrips feed ``<img>``, both of which need a URL. Path containment is
        enforced by the service, so this cannot escape the project folder.
        """
        path = media.require_file(asset)
        return FileResponse(path)

    @app.post("/project/scan", response_model=ScanResponse, dependencies=[Authorized])
    async def scan(body: ScanRequest, media: ServiceDep) -> ScanResponse:
        return ScanResponse(entries=media.scan(body.subtree))

    @app.get("/cache/stats", response_model=CacheStatsModel, dependencies=[Authorized])
    async def cache_stats(media: ServiceDep) -> CacheStatsModel:
        size_bytes, file_count = media.cache_stats()
        return CacheStatsModel(size_bytes=size_bytes, file_count=file_count)

    @app.post("/cache/clear", response_model=CacheStatsModel, dependencies=[Authorized])
    async def clear_cache(media: ServiceDep) -> CacheStatsModel:
        media.clear_cache()
        size_bytes, file_count = media.cache_stats()
        return CacheStatsModel(size_bytes=size_bytes, file_count=file_count)

    @app.post("/export/start", response_model=ExportStatusModel, dependencies=[Authorized])
    async def export_start(
        body: ExportStartRequest, media: ServiceDep, encoder: EncoderDep
    ) -> ExportStatusModel:
        """Spawn an encoder and hold its stdin open."""
        destination = media.resolve(body.output)
        audio_path = media.require_file(body.audio) if body.audio is not None else None

        job = await encoder.start(
            body.job_id,
            destination,
            width=body.width,
            height=body.height,
            frame_rate=body.frame_rate,
            codec=body.codec,
            crf=body.crf,
            speed=body.speed,
            expected_frames=body.expected_frames,
            audio_path=audio_path,
            audio_codec=body.audio_codec,
            audio_bitrate_kbps=body.audio_bitrate_kbps,
        )
        return _export_status(job, media)

    @app.post(
        "/export/{job_id}/frames", response_model=ExportStatusModel, dependencies=[Authorized]
    )
    async def export_frames(
        job_id: str, request: Request, media: ServiceDep, encoder: EncoderDep
    ) -> ExportStatusModel:
        """Stream raw RGBA frames into the encoder.

        The body is consumed as it arrives rather than buffered: an export is far larger than
        memory, and
        awaiting each write is what applies backpressure to the renderer.
        """
        job = encoder.get(job_id)
        async for chunk in request.stream():
            if chunk:
                await encoder.write_frames(job, chunk)
        return _export_status(job, media)

    @app.get("/export/{job_id}", response_model=ExportStatusModel, dependencies=[Authorized])
    async def export_status(
        job_id: str, media: ServiceDep, encoder: EncoderDep
    ) -> ExportStatusModel:
        return _export_status(encoder.get(job_id), media)

    @app.post(
        "/export/{job_id}/finish", response_model=ExportStatusModel, dependencies=[Authorized]
    )
    async def export_finish(
        job_id: str, media: ServiceDep, encoder: EncoderDep
    ) -> ExportStatusModel:
        job = await encoder.finish(encoder.get(job_id))
        return _export_status(job, media)

    @app.post(
        "/export/{job_id}/cancel", response_model=ExportStatusModel, dependencies=[Authorized]
    )
    async def export_cancel(
        job_id: str, media: ServiceDep, encoder: EncoderDep
    ) -> ExportStatusModel:
        job = await encoder.cancel(encoder.get(job_id))
        return _export_status(job, media)

    @app.get(
        "/segment/capabilities",
        response_model=SegmentCapabilitiesModel,
        dependencies=[Authorized],
    )
    async def segment_capabilities(segmenter: SegmenterDep) -> SegmentCapabilitiesModel:
        """Report whether segmentation can run, and why not when it cannot."""
        capabilities = segmenter.capabilities()
        return SegmentCapabilitiesModel(
            available=capabilities.available,
            propagates=capabilities.propagates,
            detail=capabilities.detail,
            model=capabilities.model,
        )

    @app.post("/segment/start", response_model=SegmentStatusModel, dependencies=[Authorized])
    async def segment_start(
        body: SegmentStartRequest, media: ServiceDep, segmenter: SegmenterDep
    ) -> SegmentStatusModel:
        """Queue a propagation over a clip's range."""
        job = await segmenter.start(
            body.job_id,
            SegmentRequest(
                source=media.require_file(body.source),
                start_frame=body.start_frame,
                end_frame=body.end_frame,
                points=tuple(
                    Point(frame=point.frame, x=point.x, y=point.y, include=point.include)
                    for point in body.points
                ),
            ),
        )
        return _segment_status(job)

    @app.get("/segment/{job_id}", response_model=SegmentStatusModel, dependencies=[Authorized])
    async def segment_status(job_id: str, segmenter: SegmenterDep) -> SegmentStatusModel:
        return _segment_status(segmenter.get(job_id))

    @app.get(
        "/segment/{job_id}/frames", response_model=SegmentFramesModel, dependencies=[Authorized]
    )
    async def segment_frames(
        job_id: str, segmenter: SegmenterDep, since: int = 0
    ) -> SegmentFramesModel:
        """Masks produced since a cursor.

        Polled with a cursor rather than streamed: a propagation produces one small object per
        frame at a human-visible rate, and a cursor makes a dropped connection cost nothing — the
        client asks again from where it was.
        """
        job = segmenter.get(job_id)
        start = max(0, since)
        return SegmentFramesModel(
            job_id=job.job_id,
            state=str(job.state),
            next_cursor=len(job.frames),
            frames=[
                SegmentFrameModel(
                    frame=mask.frame,
                    width=mask.width,
                    height=mask.height,
                    counts=list(mask.counts),
                )
                for mask in job.frames[start:]
            ],
        )

    @app.post(
        "/segment/{job_id}/cancel", response_model=SegmentStatusModel, dependencies=[Authorized]
    )
    async def segment_cancel(job_id: str, segmenter: SegmenterDep) -> SegmentStatusModel:
        return _segment_status(await segmenter.cancel(segmenter.get(job_id)))

    @app.post(
        "/segment/{job_id}/write", response_model=SegmentStatusModel, dependencies=[Authorized]
    )
    async def segment_write(
        job_id: str, folder: str, media: ServiceDep, segmenter: SegmenterDep
    ) -> SegmentStatusModel:
        """Write a job's masks into the cache folder the renderer chose.

        Containment is enforced by the media service, so this cannot write outside the project.
        """
        job = segmenter.get(job_id)
        segmenter.write_masks(job, media.resolve(folder))
        return _segment_status(job)

    return app


def _segment_status(job: SegmentJob) -> SegmentStatusModel:
    """Project a segmentation job onto the wire model."""
    return SegmentStatusModel(
        job_id=job.job_id,
        state=str(job.state),
        frames_done=len(job.frames),
        expected_frames=job.expected,
        progress=job.progress,
        error=job.error,
    )


def _export_status(job, media: MediaService) -> ExportStatusModel:
    """Project a job onto the wire model, reporting the output project-relative."""
    try:
        output = to_relative(media.root, job.output)
    except PathError:
        output = str(job.output)
    return ExportStatusModel(
        job_id=job.job_id,
        state=job.state.value,
        frames_written=job.frames_written,
        expected_frames=job.expected_frames,
        output=output,
        error=job.error,
    )
