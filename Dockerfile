# --- The backend ------------------------------------------------------------
# Bookworm, not the older Debian the 9.4 images are stuck on: its
# assembler cannot build the current crypto dependencies.
FROM haskell:9.10-slim-bookworm AS build
WORKDIR /build
# Dependencies first, so they are cached until the cabal files change.
COPY joyai.cabal cabal.project ./
RUN cabal update && cabal build --only-dependencies exe:joyai
COPY src src
COPY app app
COPY LICENSE .
# libgmp is the one shared library the binary needs that the runtime
# image lacks, so it is carried across with it.
RUN cabal build exe:joyai \
 && cp "$(cabal list-bin joyai)" /build/joyai \
 && cp "$(find /usr/lib -name 'libgmp.so.10' | head -n 1)" /build/libgmp.so.10

# --- The piece: backend, frontend and voice ---------------------------------
FROM python:3.12-slim-bookworm
# Which Piper voice both faces speak with. en_US-joe-medium is CC0; any
# voice from https://huggingface.co/rhasspy/piper-voices works, each
# under its own licence. Build with --build-arg PIPER_VOICE= (empty) to
# leave the voice out and fall back to the browser's.
ARG PIPER_VOICE=en_US-joe-medium
WORKDIR /app
RUN pip install --no-cache-dir "piper-tts[alignment]==1.8.0"
RUN mkdir -p /app/voices \
 && if [ -n "$PIPER_VOICE" ]; then \
      python -m piper.download_voices --download-dir /app/voices "$PIPER_VOICE"; \
    fi
COPY --from=build /build/libgmp.so.10 /usr/local/lib/
RUN ldconfig
COPY --from=build /build/joyai /app/joyai
COPY tts tts
COPY docker/entrypoint.sh /app/entrypoint.sh
COPY frontend frontend
# One port: the page, /health, recordings and the WebSocket feed.
ENV PORT=8080 PIPER_VOICE=${PIPER_VOICE}
EXPOSE 8080
USER nobody
CMD ["/app/entrypoint.sh"]
