# 🏷 Demirbaş Takip Sistemi

Node.js + Express + **SQL Server** tabanlı çok kullanıcılı demirbaş yönetim sistemi.  
JWT kimlik doğrulama, fotoğraf yükleme, QR kod üretme ve tarama desteği içerir.

---

## 📋 Gereksinimler

- Node.js 18+
- SQL Server 2019+ (veya Azure SQL)
- sqlcmd (kurulum adımı için)

---

## 🚀 Kurulum

### 1. SQL Server Veritabanı Hazırlama

#### SQL Server'ı yüklemediyseniz (Windows)

1. [SQL Server Developer Edition](https://www.microsoft.com/en-us/sql-server/sql-server-downloads)'ı indirin ve kurun.
2. Kurulum sırasında **Mixed Mode (SQL Server and Windows Authentication)** seçin ve `sa` şifresi belirleyin.
3. [SQL Server Management Studio (SSMS)](https://aka.ms/ssmsfullsetup) veya [Azure Data Studio](https://aka.ms/azuredatastudio)'yu kurun.

#### Tabloları oluşturun

**sqlcmd ile (komut satırı):**

```bash
sqlcmd -S localhost -U sa -P SIFRENIZ -i backend/init.sql
```

**SSMS / Azure Data Studio ile:**

1. Sunucuya bağlanın → `localhost`, Authentication: `SQL Server Authentication`, User: `sa`
2. `backend/init.sql` dosyasını açın → **Execute (F5)**

`init.sql` şunları otomatik oluşturur:

- `demirbase` veritabanı
- `users` tablosu (JWT auth için)
- `demirbaslar` tablosu (demirbaş kayıtları)
- `settings` tablosu (kategoriler, mekanlar, izinli e-postalar)
- `demirbase_stats` view'i
- `updated_at` trigger'ı

---

### 2. Backend Kurulumu

```bash
cd backend

# Bağımlılıkları yükle
npm install

# .env dosyasını oluştur
cp .env.example .env
```

**.env dosyasını düzenleyin:**

```env
# SQL Server Bağlantı Bilgileri
DB_HOST=localhost
DB_PORT=1433
DB_NAME=demirbase
DB_USER=sa
DB_PASSWORD=BURAYA_SA_SIFRENIZI_YAZIN

# Local kurulum için bu ikisi true kalmalı
DB_ENCRYPT=false
DB_TRUST_CERT=true

# JWT — güçlü ve rastgele bir değer yazın
JWT_SECRET=degistirin-rastgele-uzun-bir-secret

# Bu e-posta ile kayıt olan kullanıcı otomatik admin olur
ADMIN_EMAIL=admin@sirketiniz.com

PORT=3001
UPLOAD_DIR=./uploads
```

> **Azure SQL kullanıyorsanız:** `DB_ENCRYPT=true`, `DB_TRUST_CERT=false` yapın.  
> `DB_HOST` olarak Azure connection string'deki sunucu adresini (`abc.database.windows.net`) kullanın.

---

### 3. Backend'i Başlatın

```bash
# Geliştirme modu (nodemon ile otomatik yeniden başlatma)
npm run dev

# veya üretim modu
npm start
```

Konsolda şunu görmelisiniz:

```
✅ SQL Server bağlantısı başarılı
🚀 Demirbaş API çalışıyor → http://localhost:3001
```

---

### 4. Frontend

`frontend/index.html` dosyasını backend ile aynı sunucudan servis edin **veya** doğrudan tarayıcıda açın.

**Aynı sunucuda çalıştırmak için** `index.html`'i `backend/public/` klasörüne koyun — `server.js` bu klasörü otomatik serve eder:

```bash
mkdir backend/public
cp frontend/index.html backend/public/index.html
# Artık http://localhost:3001 adresinde erişilebilir
```

**Farklı adreste çalışıyorsa** `index.html` içindeki `API` değişkenini güncelleyin:

```js
var API = 'http://localhost:3001'; // backend adresi
```

---

### 5. İlk Giriş

1. Tarayıcıda `http://localhost:3001` adresini açın.
2. **Kayıt Ol** sekmesine geçin.
3. `.env`'de belirlediğiniz `ADMIN_EMAIL` adresiyle kayıt olun → otomatik **admin** yetkisi verilir.
4. Diğer kullanıcılar kayıt olmadan önce admin panelinden e-postalarını **izinli e-postalar** listesine eklemeniz gerekir.

---

## 🌐 API Endpointleri

### Auth

| Method | URL | Açıklama |
|--------|-----|----------|
| POST | `/api/auth/register` | Kayıt ol |
| POST | `/api/auth/login` | Giriş yap → JWT döner |
| GET | `/api/auth/me` | Token doğrula |

Tüm diğer endpointler `Authorization: Bearer <token>` header'ı gerektirir.

### Demirbaşlar

| Method | URL | Açıklama |
|--------|-----|----------|
| GET | `/api/assets` | Listele (arama + sayfalama) |
| GET | `/api/assets?search=monitör&category=Elektronik` | Filtrele |
| GET | `/api/assets/:id` | Tek kayıt |
| GET | `/api/assets/barcode/:barcodeId` | QR ile ara |
| POST | `/api/assets` | Yeni ekle (multipart/form-data) |
| PUT | `/api/assets/:id` | Güncelle |
| PATCH | `/api/assets/:id/quantity` | Sadece adet güncelle |
| DELETE | `/api/assets/:id` | Sil |

### Ayarlar & İstatistik

| Method | URL | Açıklama |
|--------|-----|----------|
| GET | `/api/settings` | Kategoriler + mekanlar |
| PUT | `/api/settings` | Güncelle *(admin)* |
| GET | `/api/settings/allowed-emails` | İzinli e-postalar *(admin)* |
| PUT | `/api/settings/allowed-emails` | Güncelle *(admin)* |
| GET | `/api/stats` | İstatistikler |
| GET | `/api/health` | Sağlık kontrolü |

### POST /api/assets — Form alanları

| Alan | Zorunlu | Açıklama |
|------|---------|----------|
| `name` | ✅ | Eşya adı |
| `location` | ✅ | Mekan |
| `category` | — | Kategori (varsayılan: Diğer) |
| `description` | — | Açıklama |
| `quantity` | — | Adet (varsayılan: 1) |
| `image` | — | Fotoğraf (jpg/png/webp/gif, max 5MB) |

---

## 🖥 Sunucuya Deploy

### PM2 ile arka planda çalıştırma

```bash
npm install -g pm2
pm2 start backend/server.js --name demirbase
pm2 startup    # sistem açılışında otomatik başlat
pm2 save
```

### IIS ile Windows Server'da çalıştırma

1. [iisnode](https://github.com/Azure/iisnode) yükleyin.
2. `web.config` dosyası oluşturun:

```xml
<configuration>
  <system.webServer>
    <handlers>
      <add name="iisnode" path="server.js" verb="*" modules="iisnode" />
    </handlers>
    <rewrite>
      <rules>
        <rule name="api">
          <match url="/*" />
          <action type="Rewrite" url="server.js" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

### Nginx reverse proxy (Linux)

```nginx
server {
    listen 80;
    server_name demirbase.sirketiniz.com;

    # Frontend
    root /var/www/demirbase/frontend;
    index index.html;

    # Backend API + uploads
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location /uploads {
        proxy_pass http://localhost:3001;
    }
}
```

---

## 🔧 Sorun Giderme

**`Login failed for user 'sa'` hatası**  
→ SQL Server Mixed Mode authentication etkin değil. SSMS'de sunucuya sağ tıklayın → Properties → Security → **SQL Server and Windows Authentication mode** seçin, servisi yeniden başlatın.

**`Cannot connect to localhost:1433` hatası**  
→ SQL Server Browser servisi ve TCP/IP protokolü kapalı olabilir.  
SQL Server Configuration Manager'ı açın:

- `SQL Server Network Configuration → Protocols → TCP/IP` → **Enable**
- `SQL Server Services → SQL Server Browser` → **Start**
- SQL Server servisini yeniden başlatın.

**`certificate verify failed` hatası (Azure SQL)**  
→ `.env`'de `DB_ENCRYPT=true` ve `DB_TRUST_CERT=false` olduğundan emin olun.

**Port 1433 güvenlik duvarı**  

```bash
# Windows Defender Firewall — inbound rule ekle
netsh advfirewall firewall add rule name="SQL Server" protocol=TCP dir=in localport=1433 action=allow
```

---

## 📁 Proje Yapısı

```
demirbase/
├── backend/
│   ├── server.js        ← Express sunucusu + tüm route'lar
│   ├── db.js            ← SQL Server bağlantı havuzu
│   ├── init.sql         ← Veritabanı kurulum scripti
│   ├── package.json
│   ├── .env.example
│   ├── public/          ← index.html buraya koyulur (opsiyonel)
│   └── uploads/         ← Yüklenen fotoğraflar
└── frontend/
    └── index.html       ← Tek sayfalık uygulama (SPA)
```
