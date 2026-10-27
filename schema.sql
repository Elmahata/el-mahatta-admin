-- قاعدة بيانات تطبيق المحطة (Cloudflare D1)
-- جدول واحد عام يخزّن كل الأنواع: zones / places / drivers / requests / config

DROP TABLE IF EXISTS docs;

CREATE TABLE docs (
  kind    TEXT NOT NULL,          -- zones | places | drivers | requests | config
  id      TEXT NOT NULL,
  data    TEXT NOT NULL,          -- JSON
  updated INTEGER NOT NULL,       -- epoch ms
  PRIMARY KEY (kind, id)
);

CREATE INDEX idx_docs_kind    ON docs(kind);
CREATE INDEX idx_docs_updated ON docs(kind, updated DESC);
