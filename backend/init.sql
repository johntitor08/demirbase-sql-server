-- Demirbaş Takip Sistemi - SQL Server Kurulum Scripti
-- Çalıştır: sqlcmd -S localhost -U sa -P <sifre> -i init.sql

IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = N'demirbase')
BEGIN
  CREATE DATABASE demirbase;
END
GO

USE demirbase;
GO

-- ─── Tablo: users ─────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'users')
BEGIN
  CREATE TABLE users (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    email      NVARCHAR(255) NOT NULL UNIQUE,
    password   NVARCHAR(255) NOT NULL,
    role       VARCHAR(20)   NOT NULL DEFAULT 'user',
    created_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
  );
  PRINT N'✅ Tablo users oluşturuldu.';
END
GO

-- ─── Tablo: settings ──────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'settings')
BEGIN
  CREATE TABLE settings (
    [key]   NVARCHAR(100) PRIMARY KEY,
    value   NVARCHAR(MAX) NOT NULL
  );
  INSERT INTO settings ([key], value) VALUES
    (N'categories',     N'["Elektronik","Mobilya","Beyaz Eşya","Ofis","Araç-Gereç","Diğer"]'),
    (N'locations',      N'[]'),
    (N'allowed_emails', N'[]');
  PRINT N'✅ Tablo settings oluşturuldu.';
END
GO

-- ─── Tablo: demirbaslar ───────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'demirbaslar')
BEGIN
  CREATE TABLE demirbaslar (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    barcode_id  VARCHAR(20)    NOT NULL UNIQUE,
    name        NVARCHAR(255)  NOT NULL,
    location    NVARCHAR(255)  NOT NULL,
    category    NVARCHAR(100)  NOT NULL DEFAULT N'Diğer',
    description NVARCHAR(MAX)  NULL,
    image_path  NVARCHAR(500)  NULL,
    quantity    INT            NOT NULL DEFAULT 1,
    created_at  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
  );

  CREATE INDEX idx_demirbaslar_name     ON demirbaslar(name);
  CREATE INDEX idx_demirbaslar_location ON demirbaslar(location);
  CREATE INDEX idx_demirbaslar_barcode  ON demirbaslar(barcode_id);
  CREATE INDEX idx_demirbaslar_category ON demirbaslar(category);

  PRINT N'✅ Tablo demirbaslar oluşturuldu.';
END
GO

-- ─── Trigger: updated_at ─────────────────────────────────────
DROP TRIGGER IF EXISTS trg_updated_at;
GO
CREATE TRIGGER trg_updated_at
ON demirbaslar AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE demirbaslar SET updated_at = SYSDATETIMEOFFSET()
  FROM demirbaslar d INNER JOIN inserted i ON d.id = i.id;
END
GO

-- ─── View: istatistikler ──────────────────────────────────────
CREATE OR ALTER VIEW demirbase_stats AS
SELECT
  COUNT(*)                                                          AS total,
  COUNT(DISTINCT location)                                         AS unique_locations,
  COUNT(DISTINCT category)                                         AS unique_categories,
  SUM(CASE WHEN CAST(created_at AS DATE) = CAST(SYSDATETIME() AS DATE) THEN 1 ELSE 0 END) AS added_today
FROM demirbaslar;
GO

PRINT N'✅ Kurulum tamamlandı.';
GO
