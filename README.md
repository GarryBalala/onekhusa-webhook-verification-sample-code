# OneKhusa Hosted Checkout — Node.js Integration

A clean, production-ready Node.js integration with the **OneKhusa Payment Gateway** using the **Request to Pay (RTP) Hosted Checkout** flow. The customer is redirected to a managed checkout page hosted by OneKhusa to complete payment — no card data ever touches your server.

---

## Table of Contents

- [Architecture](#architecture)
- [Hosted Checkout Flow](#hosted-checkout-flow)
- [Request to Pay — Full Lifecycle](#request-to-pay--full-lifecycle)
- [Webhook Processing](#webhook-processing)
- [When the Callback URL Is Unreachable or Invalid](#when-the-callback-url-is-unreachable-or-invalid)
- [Setup & Installation](#setup--installation)
- [API Endpoints](#api-endpoints)
- [Configuration](#configuration)
- [Project Structure](#project-structure)

---

## Architecture

```mermaid
flowchart LR
    subgraph Customer["👤 Customer"]
        Browser["Browser"]
    end

    subgraph YourServer["🖥️ Your Server (Node.js)"]
        Express["Express App"]
        Service["OneKhusaService"]
        Cache["StatusCache"]
    end

    subgraph OneKhusa["☁️ OneKhusa Gateway"]
        Token["/account/getAccessToken"]
        Checkout["/checkout/rtp/initiate"]
        HostedPage["Hosted Checkout Page"]
        Webhook["Webhook Delivery"]
    end

    Browser -->|"1. POST /api/Tickets/buy/:eventId"| Express
    Express -->|"2. initiateCheckout()"| Service
    Service -->|"3. POST (credentials)"| Token
    Token -->|"4. JWT"| Service
    Service -->|"5. POST (JWT + payload)"| Checkout
    Checkout -->|"6. paymentTransactionId"| Service
    Service -->|"7. redirect URL"| Express
    Express -->|"8. { redirectUrl }"| Browser
    Browser -->|"9. Redirect"| HostedPage
    HostedPage -->|"10. Customer pays"| HostedPage
    HostedPage -->|"11. Redirect → success.html?ref=..."| Browser
    Webhook -->|"12. POST /webhooks/payments"| Express
    Express -->|"13. Update status"| Cache
```

---

## Hosted Checkout Flow

This is the primary payment flow. The customer enters payment details on your page, then is redirected to OneKhusa's managed checkout to complete the transaction.

```mermaid
sequenceDiagram
    autonumber
    participant C as 👤 Customer
    participant App as 🖥️ Node.js Server
    participant API as ☁️ OneKhusa API
    participant Hosted as 🌐 Hosted Checkout Page

    C->>App: POST /api/Tickets/buy/:eventId<br/>{reference, amount, description}

    Note over App: Get or refresh JWT access token<br/>(cached for 4 minutes)

    App->>API: POST /account/getAccessToken<br/>{apiKey, apiSecret, orgId, merchantNo}
    API-->>App: { accessToken: "eyJhbG..." }

    App->>API: POST /checkout/rtp/initiate<br/>{authentication, merchant, payment, route}
    API-->>App: { paymentTransactionId: "abc123" }

    Note over App: Store status = "Pending" in cache<br/>Build redirect URL

    App-->>C: { redirectUrl: "https://checkout.onekhusa.com/...?ptid=abc123" }

    C->>Hosted: Redirect to Hosted Checkout Page
    Note over C,Hosted: Customer enters phone number /<br/>selects payment method / confirms

    alt Payment Successful
        Hosted-->>C: Redirect → /success.html?ref=OT-NJ-12345
        C->>App: GET /success.html?ref=OT-NJ-12345
        Note over App: Return static success page
        C->>App: GET /api/Tickets/status/OT-NJ-12345 (polling)
        App-->>C: { status: "Paid" }
    else Payment Failed / Cancelled
        Hosted-->>C: Redirect → /error.html?ref=OT-NJ-12345
        C->>App: GET /error.html?ref=OT-NJ-12345
        Note over App: Return static error page
    end
```

### Step-by-Step Breakdown

| Step | What Happens |
|------|-------------|
| 1 | Customer fills in **reference**, **amount**, and **description** on your page and clicks "Purchase" |
| 2 | Your server obtains a **JWT access token** from OneKhusa (cached for 4 minutes) |
| 3 | Your server calls `POST /checkout/rtp/initiate` with payment details and redirect routes |
| 4 | OneKhusa returns a `paymentTransactionId` |
| 5 | Your server builds the **hosted checkout redirect URL** and returns it to the browser |
| 6 | The browser **redirects the customer** to the OneKhusa-hosted checkout page |
| 7 | The customer completes payment on the hosted page (USSD prompt, mobile money, etc.) |
| 8 | On **success**, OneKhusa redirects to `success.html?ref=...` — your page polls `/api/Tickets/status/:ref` until status is `Paid` |
| 9 | On **failure**, OneKhusa redirects to `error.html?ref=...` — the customer sees a failure message and can retry |
| 10 | Independently, OneKhusa sends a **webhook** to `/webhooks/payments` confirming the result |

---

## Request to Pay — Full Lifecycle

This diagram shows the complete lifecycle including the background webhook that runs **in parallel** with the customer-facing redirect flow.

```mermaid
flowchart TD
    Start([Customer clicks Purchase]) --> A

    A["📱 Customer enters payment details<br/>reference, amount, description"]
    B["🖥️ Server obtains JWT token<br/>(cached 4 min)"]
    C["☁️ POST /checkout/rtp/initiate<br/>payment details + redirect routes"]
    D["✅ paymentTransactionId received"]
    E["🔗 Customer redirected to<br/>OneKhusa Hosted Checkout"]
    F["💰 Customer completes payment"]

    G{"Payment result?"}

    H["☁️ OneKhusa sends webhook<br/>POST /webhooks/payments"]
    I["📝 Update status cache<br/>Paid / Failed"]

    J["🔄 Redirect → /success.html?ref=...<br/>Page polls /api/Tickets/status/:ref"]
    K["✅ Status = Paid<br/>Show confirmation"]

    L["❌ Redirect → /error.html?ref=...<br/>Customer sees failure page"]

    M["📊 GET /api/Tickets/status/:ref<br/>Frontend polls every 2s"]

    Start --> A --> B --> C --> D --> E --> F --> G

    G -->|"Success ✅"| H
    G -->|"Failure ❌"| L

    H --> I
    I --> M
    M --> K

    J -.->|"Polls"| M

    style Start fill:#3b82f6,color:#fff
    style K fill:#10b981,color:#fff
    style L fill:#ef4444,color:#fff
    style I fill:#f59e0b,color:#fff
```

---

## Webhook Processing

OneKhusa sends a `POST` request to your `callbackApiUrl` whenever a payment status changes. The webhook is the **source of truth** — the polling on the frontend is just a convenience layer.

```mermaid
flowchart LR
    A["☁️ OneKhusa<br/>sends webhook"] --> B["POST /webhooks/payments"]
    B --> C{"Resolve reference"}
    C -->|"metaData.ReferenceNumber"| D["Reference found"]
    C -->|"metaData.referenceNumber"| D
    C -->|"sourceReferenceNumber"| D
    C -->|"Not found"| E["ACK 200<br/>(unresolvable)"]
    D --> F{"Check event type"}
    F -->|"success / S100 / S"| G["Status = Paid"]
    F -->|"other"| H["Status = Failed"]
    G --> I["Update status cache"]
    H --> I
    I --> J["ACK 200 OK"]
```

### Webhook Payload Structure

OneKhusa may send the reference in different fields. The handler checks all of them:

```
metaData.ReferenceNumber    ← TitleCase (most common)
metaData.referenceNumber    ← camelCase
sourceReferenceNumber       ← top-level
payment.sourceReferenceNumber ← nested
```

### Success Detection

A payment is considered successful if **any** of these conditions are true:

| Field | Value |
|-------|-------|
| `eventType` / `event` / `type` | Contains `"success"` |
| `responseCode` | `"S100"` or starts with `"S"` |
| `transactionStatusCode` | `"S"` |

---

## When the Callback URL Is Unreachable or Invalid

This is a critical scenario to understand. The `callbackApiUrl` in the checkout initiation payload tells OneKhusa where to send the webhook. Here's what happens when it fails:

### Scenario: Callback URL is Unreachable (e.g., ngrok is down)

```mermaid
flowchart TD
    A["☁️ Payment completed<br/>by customer"] --> B["☁️ OneKhusa attempts<br/>webhook delivery"]
    B --> C{"Callback URL<br/>reachable?"}
    C -->|"❌ Connection refused<br/>DNS failure<br/>Timeout"| D["OneKhusa logs delivery failure"]
    D --> E["OneKhusa RETRIES<br/>with exponential backoff"]
    E --> F{"Retry successful?"}
    F -->|"✅ Yes"| G["Webhook delivered<br/>Status updated"]
    F -->|"❌ No — max retries<br/>exhausted"| H["⚠️ Webhook permanently failed"]

    H --> I["The customer was ALREADY<br/>redirected to success.html"]
    I --> J["Frontend polls status endpoint"]
    J --> K{"Status in cache?"}
    K -->|"Pending (never updated)"| L["❌ Frontend shows<br/>'Verifying...' forever"]

    style H fill:#ef4444,color:#fff
    style L fill:#f59e0b,color:#fff
```

### What Actually Happens — In Detail

| Aspect | Behaviour |
|--------|-----------|
| **Customer experience** | The customer is **still redirected** to `success.html` or `error.html` because the redirect happens via the browser, not the webhook. The hosted checkout page sends the customer back regardless of webhook delivery. |
| **Webhook retries** | OneKhusa implements **automatic retries** with exponential backoff. If your server is temporarily down (e.g., ngrok tunnel restarted), the webhook will succeed on a later retry. |
| **Status remains "Pending"** | If the webhook never arrives, the status cache stays at `"Pending"`. The frontend polling will keep showing "Verifying Payment..." indefinitely. |
| **No data loss** | OneKhusa keeps a record of the transaction. You can reconcile later by querying the OneKhusa dashboard or using their API. |

### Mitigation Strategies

| Strategy | Description |
|----------|-------------|
| **Use a stable URL** | Avoid ngrok in production. Use a real domain with HTTPS. |
| **Health check endpoint** | Add a `GET /health` route and monitor it. |
| **Dashboard reconciliation** | Periodically check the OneKhusa merchant portal for transactions that never received a webhook. |
| **Idempotent webhook handler** | Our handler is idempotent — if OneKhusa retries, receiving the same webhook twice is safe. The status cache simply gets overwritten with the same value. |
| **Graceful frontend timeout** | Add a timeout to the polling loop so the customer sees a "Taking too long? Check your email" message instead of spinning forever. |

### Scenario: Callback URL is Invalid (e.g., wrong path)

| Situation | What Happens |
|-----------|-------------|
| URL points to a non-existent route | OneKhusa gets a **404 Not Found** response. This is treated as a delivery failure and retried. |
| URL points to a route that returns non-200 | Same as above — any response outside `200-299` is a failure. |
| URL has wrong protocol (http vs https) | May cause SSL/TLS errors. OneKhusa logs the failure and retries. |
| URL is malformed | OneKhusa rejects it at initiation time — you'll get an API error when calling `/checkout/rtp/initiate`. |

> **Important:** The `successRedirectionUrl` and `failureRedirectionUrl` are **browser redirects** (not webhooks). They work independently of the `callbackApiUrl`. Even if the callback URL is wrong, the customer will still be redirected to your success or error page.

---

## Setup & Installation

### Prerequisites

- **Node.js** ≥ 18
- **OneKhusa** sandbox credentials (API key, secret, org ID, merchant number)
- **ngrok** (for local development) or a public URL

### Install & Run

```bash
# Clone / navigate to the project
cd onekhusa-nodejs-integration

# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your credentials

# Start the server
npm start
```

### Using ngrok

```bash
# In a separate terminal, tunnel port 8080
ngrok http 8080

# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.dev)
# and set it as PUBLIC_CALLBACK_URL in your .env
```

### Run in Development Mode

```bash
# Auto-restarts on file changes
npm run dev
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Dashboard — customer payment form |
| `POST` | `/api/Tickets/buy/:eventId` | Initiate a hosted checkout payment |
| `GET` | `/api/Tickets/status/:reference` | Poll payment status (`Pending`, `Paid`, `Failed`, `NotFound`) |
| `POST` | `/webhooks/payments` | OneKhusa webhook callback |
| `GET` | `/success.html` | Success redirect page (polls status, shows confirmation) |
| `GET` | `/error.html` | Failure redirect page (shows error, retry link) |

---

## Configuration

All configuration is driven by environment variables. Copy `.env.example` to `.env` and fill in your values.

| Variable | Description | Default |
|----------|-------------|---------|
| `ONEKHUSA_API_KEY` | Your sandbox/production API key | — |
| `ONEKHUSA_API_SECRET` | Your sandbox/production API secret | — |
| `ONEKHUSA_ORG_ID` | Organisation ID | — |
| `ONEKHUSA_MERCHANT_NUMBER` | Merchant account number | — |
| `ONEKHUSA_TOKEN_URL` | Token endpoint | `https://api.onekhusa.com/sandbox/v1/account/getAccessToken` |
| `ONEKHUSA_CHECKOUT_URL` | Checkout initiation endpoint | `https://api.onekhusa.com/sandbox/v1/checkout/rtp/initiate` |
| `ONEKHUSA_CHECKOUT_REDIRECT_URL` | Hosted checkout page base URL | `https://checkout.onekhusa.com/requestToPay/initiate` |
| `PUBLIC_CALLBACK_URL` | Your public URL (ngrok or domain) | — |
| `PORT` | Server port | `8080` |

---

## Project Structure

```
onekhusa-nodejs-integration/
├── .env                      # Environment variables (not committed)
├── .env.example              # Template for .env
├── package.json
├── public/
│   ├── index.html            # Customer payment form
│   ├── success.html          # Success redirect page (polls for confirmation)
│   └── error.html            # Failure redirect page
└── src/
    ├── app.js                # Express entry point
    ├── config/
    │   └── index.js          # Centralized configuration from env
    ├── routes/
    │   └── index.js          # Route handlers (buy, status, webhook)
    ├── services/
    │   └── onekhusa.service.js   # OneKhusa API wrapper (token, checkout)
    └── utils/
        └── statusCache.js    # TTL-backed in-memory status cache
```

---

## License

ISC
