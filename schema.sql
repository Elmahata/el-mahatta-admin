-- قاعدة بيانات تطبيق المحطة (Cloudflare D1)
-- جدول واحد عام يخزّن كل الأنواع: zones / places / drivers / requests / config
-- آمن: بيعمل الجدول لو مش موجود بس — مابيمسحش أي بيانات لو اتشغّل تاني

CREATE TABLE IF NOT EXISTS docs (
  kind    TEXT NOT NULL,          -- zones | places | drivers | requests | config
  id      TEXT NOT NULL,
  data    TEXT NOT NULL,          -- JSON
  updated INTEGER NOT NULL,       -- epoch ms
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS idx_docs_kind    ON docs(kind);
CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(kind, updated DESC);
