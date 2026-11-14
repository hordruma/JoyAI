FROM haskell:9.4-slim AS build
WORKDIR /build
# Dependencies first, so they are cached until the cabal files change.
COPY joyai.cabal cabal.project ./
RUN cabal update && cabal build --only-dependencies exe:joyai
COPY src src
COPY app app
COPY LICENSE .
RUN cabal build exe:joyai \
 && cp "$(cabal list-bin joyai)" /build/joyai

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libgmp10 zlib1g \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/joyai /app/joyai
COPY frontend frontend
# One port: the page, /health and the WebSocket feed.
ENV PORT=8080
EXPOSE 8080
USER nobody
CMD ["/app/joyai"]
