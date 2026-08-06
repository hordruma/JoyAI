FROM haskell:9.4-slim AS build
WORKDIR /build
COPY sadclown-pipeline.cabal .
RUN cabal update && cabal build --only-dependencies
COPY src src
COPY app app
COPY LICENSE .
RUN cabal build exe:sadclown-pipeline \
 && cp "$(cabal list-bin sadclown-pipeline)" /build/sadclown-pipeline

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libgmp10 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/sadclown-pipeline /app/sadclown-pipeline
COPY frontend frontend
# 8080: WebSocket broadcast, 8081: frontend + /health
EXPOSE 8080 8081
CMD ["/app/sadclown-pipeline"]
