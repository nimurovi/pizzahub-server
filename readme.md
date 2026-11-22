# PizzaHub — Backend API

## Project Description

**PizzaHub Server** is the backend REST API for the PizzaHub online food ordering platform. Built with Node.js, Express.js, and MongoDB, it handles authentication, authorization, menu management, customer orders, vendor operations, reviews and ratings, subscription billing, and administrative functionality.

The backend uses Better Auth for session management, JWT verification for protected API access, and role-based authorization to secure customer, vendor, and admin operations.

## Live Website and Repositories

- **Live Website:** https://pizzahub-dusky-rho.vercel.app/
- **Backend API:** https://pizzahub-server-tawny.vercel.app
- **Server Repository:** https://github.com/nimurovi/pizzahub-server.git
- **Client Repository:** https://github.com/nimurovi/pizzahub.git

## Important Features

- Authentication using Better Auth with email/password and Google OAuth.
- JWT verification and role-based access control.
- Admin, Vendor, and Customer account permissions.
- MongoDB database integration.
- Food menu creation, updating, deletion, and availability management.
- Public menu browsing, filtering, sorting, and pagination.
- Customer order placement, order history, and cancellation.
- Vendor order acceptance and rejection.
- Food item and restaurant reviews and ratings.
- Admin user management and menu moderation.
- Stripe integration for premium vendor subscriptions.
- Stripe webhook handling.
- Image uploads using ImgBB with Multer and Sharp.
- Request validation, CORS restrictions, and centralized error handling.
- Automated security and review-related tests.

## Technology Stack

| Technology / npm Package | Version / Purpose |
|---|---|
| Node.js | JavaScript runtime |
| Express.js | ^5.3.0 — Backend framework |
| MongoDB | ^7.9.0 — Database driver |
| Better Auth | ^1.7.26 — Authentication |
| @better-auth/mongo-adapter | ^1.7.26 — MongoDB adapter |
| Jose | ^6.2.18 — JWT verification |
| CORS | ^2.8.6 — Cross-origin request handling |
| Dotenv | ^18.0.10 — Environment configuration |
| Multer | ^2.5.0 — File uploads |
| Sharp | ^0.35.5 — Image processing |
| Stripe | 18.3.0 — Billing and subscriptions |
| Mingo | ^7.2.7 — Development/testing |
| mongodb-memory-server-core | ^11.4.0 — Integration testing |
| Vercel | Backend deployment |

## Installation Steps

**Prerequisites:** Node.js, npm, MongoDB, and the credentials needed for the integrations being used.

1. Clone the backend repository:

```bash
git clone https://github.com/nimurovi/pizzahub-server.git
```

2. Navigate into the server directory:

```bash
cd pizzahub-server
```

3. Install dependencies:

```bash
npm install
```

## Environment Variables

Create a `.env` file in the backend project root.

```dotenv
PORT=5000
CLIENT_URL=http://localhost:3000
DB_NAME=pizzahub

MONGODB_URI=

BETTER_AUTH_URL=http://localhost:5000
BETTER_AUTH_SECRET=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

IMGBB_API_KEY=

STRIPE_PREMIUM_PRICE_ID=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

### Environment Variable Description

| Variable | Description |
|---|---|
| PORT | Backend server port |
| CLIENT_URL | Allowed frontend origin |
| DB_NAME | MongoDB database name |
| MONGODB_URI | MongoDB connection string |
| BETTER_AUTH_URL | Backend's public authentication base URL |
| BETTER_AUTH_SECRET | Secure authentication secret, at least 32 characters |
| GOOGLE_CLIENT_ID | Google OAuth client ID |
| GOOGLE_CLIENT_SECRET | Google OAuth client secret |
| IMGBB_API_KEY | ImgBB API key for image uploads |
| STRIPE_PREMIUM_PRICE_ID | Premium subscription Stripe price ID |
| STRIPE_SECRET_KEY | Stripe secret API key |
| STRIPE_WEBHOOK_SECRET | Stripe webhook signature verification secret |

Never commit the `.env` file or expose private credentials.

## How to Run Locally

Start the server:

```bash
npm start
```

Default server URL:

http://localhost:5000

### Example API Endpoints

```text
GET /                         # Backend health endpoint
GET /api/menu                 # Public menu
GET /api/menu/featured        # Featured menu items
GET /api/auth/get-session     # Authentication session
GET /api/auth/jwks            # Public JWT verification keys
```

Protected API endpoints require appropriate authentication and role permissions.

## Testing

Run the security and review tests:

```bash
npm test
```

Run the MongoDB-backed review integration tests:

```bash
npm run test:integration
```

Integration tests may require a compatible local test environment.

## Project Structure

```text
pizzahub-server/
├── index.js                    # Express application
├── billing.js                  # Subscription and payment logic
├── billing-policy.js           # Premium subscription policy
├── reviews.js                  # Ratings and reviews
├── security-check.test.js      # Security tests
├── reviews.test.js             # Review tests
├── reviews.mongo.test.js       # MongoDB review tests
├── test-support/               # Test utilities
├── .env.example                # Environment variable template
├── package.json
├── vercel.json
└── README.md
```

## Deployment

The backend is deployed on Vercel.

For the provided production domains, configure:

```dotenv
CLIENT_URL=https://pizzahub-dusky-rho.vercel.app
BETTER_AUTH_URL=https://pizzahub-server-tawny.vercel.app
```

The frontend must use:

```dotenv
NEXT_PUBLIC_API_URL=https://pizzahub-server-tawny.vercel.app
```

Use stable production domains rather than deployment-specific URLs.

Ensure MongoDB access, Google OAuth configuration, Stripe webhooks, and cross-site session-cookie settings are configured correctly for production.

**Live Website:** https://pizzahub-dusky-rho.vercel.app

**Backend API:** https://pizzahub-server-tawny.vercel.app