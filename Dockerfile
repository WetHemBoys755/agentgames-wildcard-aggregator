# Hugging Face Spaces (Docker SDK) — runs the same Node server as a
# persistent container. No build step: the server is stdlib-only.
# The Space listens on $PORT (7860 on Spaces).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json main.ts ./
COPY lib ./lib
ENV PORT=7860
EXPOSE 7860
CMD ["node", "--experimental-strip-types", "main.ts"]
