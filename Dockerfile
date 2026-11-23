# 資産形成シミュレーター（単一プロセス＋永続ボリューム上の SQLite）
# Node は検証済みの 24.11.1 に固定（node:sqlite を使用。Node 24 では実験的機能のため、版を上げる場合は再検証が必要）
# ※ この Dockerfile は開発端末に Docker がなく、ビルド未検証です（docs/LIMITATIONS.md）。
# 市場データ（market-data/）はイメージに含めない。取込ファイルは管理画面から取り込む（docs/DATA_INPUT.md）。
FROM node:24.11.1-bookworm-slim

ENV NODE_ENV=production \
    APP_ENV=prod \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/app.sqlite

WORKDIR /app
# 外部依存パッケージなし（npm install 不要）
COPY package.json .nvmrc ./
COPY server ./server
COPY public ./public
COPY scripts/purge.js ./scripts/purge.js

# 永続データ: /data（所有者 node、権限 700）。参加者データを含むため、バックアップ対象・スナップショット対象の扱いは docs/OPERATIONS.md を参照
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8080

# ヘルスチェック（DB 読み出しまで確認。内部情報は返さない）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM で正常終了（受付停止 → 処理中リクエスト完了 → DB クローズ）
STOPSIGNAL SIGTERM
CMD ["node", "server/index.js"]
