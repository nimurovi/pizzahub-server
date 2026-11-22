import "dotenv/config";
import { registerReviews, ratingStages } from "./reviews.js";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { createAuthMiddleware, APIError } from "better-auth/api";
import multer from "multer";
import sharp from "sharp";
import { createBilling } from "./billing.js";
import { premiumExpression } from "./billing-policy.js";
import { jwt } from "better-auth/plugins";
import { createRemoteJWKSet, jwtVerify } from "jose";
// ==================================================
// Environment configuration
// ==================================================

const port = Number(process.env.PORT || 5000);
const clientUrl = process.env.CLIENT_URL;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.DB_NAME || "pizzahub";

if (!mongoUri || !clientUrl) {
    console.error("Missing MONGODB_URI or CLIENT_URL in .env");
    process.exit(1);
}

// ==================================================
// Express and MongoDB
// ==================================================

const app = express();
let initializationPromise;

app.use((req, res, next) => {
    if (!initializationPromise) {
        return res.status(503).json({
            success: false,
            message: "Server is initializing.",
        });
    }

    initializationPromise.then(
        () => next(),
        (error) => {
            console.error("Initialization failed:", error.message);

            res.status(503).json({
                success: false,
                message: "Server initialization failed.",
            });
        }
    );
});
app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "PizzaHub Backend API is running",
        status: "OK",
    });
});

app.disable("x-powered-by");

app.use(
    cors({
        origin: clientUrl,
        credentials: true,
    })
);

const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
});

// ==================================================
// Start server
// ==================================================

async function startServer() {
    await client.connect();

    const db = client.db(databaseName);

    // Declare collections BEFORE indexes and routes.
    const usersCollection = db.collection("users");
    const menuItemsCollection = db.collection("menuItems");
    const ordersCollection = db.collection("orders");

    await db.command({ ping: 1 });

    console.log("MongoDB connected successfully.");

    if (
        !process.env.BETTER_AUTH_SECRET ||
        process.env.BETTER_AUTH_SECRET.length < 32 ||
        !process.env.BETTER_AUTH_URL
    ) {
        throw new Error(
            "Set BETTER_AUTH_URL and a BETTER_AUTH_SECRET of at least 32 characters."
        );
    }

    // ==================================================
    // Application indexes
    // ==================================================

    await ordersCollection.createIndex({
        customerId: 1,
        createdAt: -1,
        _id: -1,
    });

    await ordersCollection.createIndex(
        {
            customerId: 1,
            itemId: 1,
            orderDate: 1,
        },
        {
            name: "unique_active_item_order_per_date",
            unique: true,
            partialFilterExpression: {
                status: { $in: ["pending", "accepted"] },
            },
        }
    );
    await ordersCollection.createIndex(
        {
            vendorId: 1,
            createdAt: -1,
            _id: -1,
        },
        {
            name: "vendor_orders_newest",
        }
    );

    await menuItemsCollection.createIndex({
        status: 1,
        isAvailable: 1,
        createdAt: -1,
        _id: -1,
    });

    // ==================================================
    // Optional development seed
    // Run manually: node index.js --seed
    // ==================================================

    if (process.argv.includes("--seed")) {
        if (process.env.NODE_ENV === "production") {
            throw new Error("Demo seeding is disabled in production.");
        }

        const demoItems = [
            {
                demoKey: "classic-margherita",
                itemName: "Classic Margherita",
                category: "classic-pizzas",
                description:
                    "Tomato sauce, mozzarella, and fresh basil on a golden crust.",
                price: 499,
                location: "Dhanmondi, Dhaka",
                vendorId: "demo-vendor-1",
                vendorName: "Demo — The Pizza Kitchen",
            },
            {
                demoKey: "garden-veggie",
                itemName: "Garden Veggie Pizza",
                category: "vegetarian-pizzas",
                description:
                    "Bell peppers, mushrooms, onions, and olives with mozzarella.",
                price: 549,
                location: "Dhanmondi, Dhaka",
                vendorId: "demo-vendor-1",
                vendorName: "Demo — The Pizza Kitchen",
            },
            {
                demoKey: "smoky-bbq-chicken",
                itemName: "Smoky BBQ Chicken",
                category: "meat-lovers",
                description:
                    "Chicken, smoky barbecue sauce, red onions, and melted cheese.",
                price: 699,
                location: "Dhanmondi, Dhaka",
                vendorId: "demo-vendor-1",
                vendorName: "Demo — The Pizza Kitchen",
            },
            {
                demoKey: "four-cheese",
                itemName: "Four Cheese Pizza",
                category: "specialty-gourmet-pizzas",
                description:
                    "A rich blend of mozzarella, cheddar, parmesan, and gouda.",
                price: 749,
                location: "Banani, Dhaka",
                vendorId: "demo-vendor-2",
                vendorName: "Demo — Slice & Spice",
            },
            {
                demoKey: "garlic-bread",
                itemName: "Cheesy Garlic Bread",
                category: "sides-appetizers",
                description:
                    "Oven-baked bread topped with garlic butter and melted cheese.",
                price: 249,
                location: "Banani, Dhaka",
                vendorId: "demo-vendor-2",
                vendorName: "Demo — Slice & Spice",
            },
            {
                demoKey: "chocolate-brownie",
                itemName: "Chocolate Brownie",
                category: "beverages-desserts",
                description:
                    "A rich chocolate brownie for a sweet finish to your meal.",
                price: 199,
                location: "Banani, Dhaka",
                vendorId: "demo-vendor-2",
                vendorName: "Demo — Slice & Spice",
            },
        ];

        for (const item of demoItems) {
            await menuItemsCollection.updateOne(
                { demoKey: item.demoKey },
                {
                    $setOnInsert: {
                        ...item,
                        images: [],
                        status: "approved",
                        isAvailable: true,
                        isDemo: true,
                        createdAt: new Date(),
                    },
                },
                { upsert: true }
            );
        }

        console.log("Demo menu items are ready.");

        await client.close();
        return;
    }

    // ==================================================
    // Better Auth
    // ==================================================

    const billing = await createBilling({ client, db, clientUrl });

    const auth = betterAuth({
        appName: "PizzaHub",
        baseURL: process.env.BETTER_AUTH_URL,
        secret: process.env.BETTER_AUTH_SECRET,
        trustedOrigins: [clientUrl],
        advanced: {
            defaultCookieAttributes: {
                sameSite: "none",
                secure: true,
                httpOnly: true,
            },
        },
        plugins: [
            jwt({
                disableSettingJwtHeader: true,

                jwks: {
                    keyPairConfig: {
                        alg: "EdDSA",
                        crv: "Ed25519",
                    },
                },

                jwt: {
                    issuer: process.env.BETTER_AUTH_URL,
                    audience: "pizzahub-api",
                    expirationTime: "5m",

                    // Do not include passwords, billing data, or client-supplied roles.
                    definePayload: ({ user }) => ({
                        sub: user.id,
                    }),
                },
            }),
        ],
        socialProviders: {
            google: {
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                prompt: "select_account",
            },
        },

        database: mongodbAdapter(db),

        emailAndPassword: {
            enabled: true,
            minPasswordLength: 6,
            maxPasswordLength: 128,
            autoSignIn: true,
        },

        user: {
            modelName: "users",

            additionalFields: {
                role: {
                    type: "string",
                    required: false,
                    defaultValue: "customer",
                    input: true,
                },

                isBlocked: {
                    type: "boolean",
                    required: false,
                    defaultValue: false,
                    input: false,
                },

                roleSelectionPending: {
                    type: "boolean",
                    required: false,
                    defaultValue: false,
                    input: false,
                },
            },
        },

        databaseHooks: {
            user: {
                create: {
                    before: async (user, ctx) => {
                        const path = ctx?.path || "";

                        const isSocialRegistration =
                            path.startsWith("/callback/") ||
                            path === "/sign-in/social";

                        if (!isSocialRegistration) {
                            return {
                                data: {
                                    ...user,
                                    roleSelectionPending: false,
                                },
                            };
                        }

                        return {
                            data: {
                                ...user,
                                role: "customer",
                                roleSelectionPending: true,
                            },
                        };
                    },
                },
            },
        },

        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                if (ctx.path === "/sign-up/email") {
                    const role = ctx.body?.role ?? "customer";

                    if (!["customer", "vendor"].includes(role)) {
                        throw new APIError("BAD_REQUEST", {
                            message: "Choose Customer or Vendor.",
                        });
                    }

                    const name = ctx.body?.name;

                    if (
                        typeof name !== "string" ||
                        name.trim().length < 2 ||
                        name.trim().length > 80
                    ) {
                        throw new APIError("BAD_REQUEST", {
                            message: "Name must contain 2–80 characters.",
                        });
                    }
                }

                // Prevent role changes through other auth endpoints.
                if (
                    ctx.path !== "/sign-up/email" &&
                    ctx.body &&
                    Object.prototype.hasOwnProperty.call(ctx.body, "role")
                ) {
                    throw new APIError("FORBIDDEN", {
                        message: "You cannot change your account role.",
                    });
                }

                const passwordPaths = [
                    "/sign-up/email",
                    "/change-password",
                    "/reset-password",
                    "/set-password",
                ];

                if (!passwordPaths.includes(ctx.path)) {
                    return;
                }

                const password =
                    ctx.path === "/sign-up/email" ||
                        ctx.path === "/set-password"
                        ? ctx.body?.password
                        : ctx.body?.newPassword;

                if (
                    typeof password !== "string" ||
                    password.length < 6 ||
                    password.length > 128 ||
                    !/[a-z]/.test(password) ||
                    !/[A-Z]/.test(password)
                ) {
                    throw new APIError("BAD_REQUEST", {
                        message:
                            "Password must contain 6–128 characters, including an uppercase and a lowercase letter.",
                    });
                }
            }),
        },
    });

    // Better Auth must come before express.json().
    // Authentication responses must not be stored by shared or browser caches.
    app.use(/^\/api\/auth(?:\/.*)?$/, (req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    app.all(/^\/api\/auth(?:\/.*)?$/, toNodeHandler(auth));

    billing.mountWebhook(app);
    app.use(express.json({ limit: "100kb" }));

    // ==================================================
    // Authentication and authorization middleware
    // ==================================================

    const jwtIssuer = process.env.BETTER_AUTH_URL;
    const jwtAudience = "pizzahub-api";

    const jwtKeys = createRemoteJWKSet(
        new URL(`${jwtIssuer.replace(/\/+$/, "")}/api/auth/jwks`)
    );

    const invalidJwtCodes = new Set([
        "ERR_JWT_EXPIRED",
        "ERR_JWT_CLAIM_VALIDATION_FAILED",
        "ERR_JWT_INVALID",
        "ERR_JWS_INVALID",
        "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
        "ERR_JOSE_ALG_NOT_ALLOWED",
        "ERR_JOSE_NOT_SUPPORTED",
        "ERR_JWKS_NO_MATCHING_KEY",
    ]);

    async function requireAccount(req, res, next) {
        // Avoid repeating verification when both the API guard
        // and the individual route apply this middleware.
        if (req.jwtVerified === true && req.account) {
            return next();
        }

        res.set("Cache-Control", "no-store");

        const unauthorized = (message) =>
            res.status(401).json({
                success: false,
                message,
            });

        const authorization = req.get("authorization");
        const match =
            typeof authorization === "string"
                ? /^Bearer ([^\s]+)$/i.exec(authorization)
                : null;

        if (!match || match[1].length > 8192) {
            return unauthorized("A Bearer JWT is required. Please sign in.");
        }

        let payload;

        try {
            const verified = await jwtVerify(match[1], jwtKeys, {
                algorithms: ["EdDSA"],
                issuer: jwtIssuer,
                audience: jwtAudience,
                requiredClaims: ["sub", "iat", "exp"],
                maxTokenAge: "5m",
                clockTolerance: 5,
            });

            payload = verified.payload;
        } catch (error) {
            if (invalidJwtCodes.has(error?.code)) {
                return unauthorized("Your access token is invalid or expired.");
            }

            // Key-server failures are service errors, not bad credentials.
            console.error("JWT verification unavailable:", {
                name: error?.name,
                code: error?.code,
            });

            return res.status(503).json({
                success: false,
                message: "Authentication is temporarily unavailable. Try again.",
            });
        }

        if (
            typeof payload.sub !== "string" ||
            payload.sub.length === 0 ||
            payload.sub.length > 200
        ) {
            return unauthorized("Invalid token subject.");
        }

        try {
            // JWT is mandatory, and its owner must still be logged in.
            // Read current session state rather than cached cookie data.
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
                query: {
                    disableCookieCache: true,
                },
            });

            if (!session?.user || session.user.id !== payload.sub) {
                return unauthorized("Your login session has ended. Please sign in.");
            }

            const possibleIds = [payload.sub];

            if (/^[a-fA-F0-9]{24}$/.test(payload.sub)) {
                possibleIds.push(new ObjectId(payload.sub));
            }

            const account = await usersCollection.findOne({
                _id: { $in: possibleIds },
            });

            if (!account) {
                return unauthorized("Account not found. Please sign in again.");
            }

            if (account.isBlocked === true) {
                return res.status(403).json({
                    success: false,
                    message: "Your account is blocked.",
                });
            }

            if (!["admin", "vendor", "customer"].includes(account.role)) {
                return res.status(403).json({
                    success: false,
                    message: "Your account does not have a permitted role.",
                });
            }

            req.account = account;
            req.jwtVerified = true;

            return next();
        } catch (error) {
            return next(error);
        }
    }

    function requireRole(...allowedRoles) {
        return (req, res, next) => {
            const account = req.account;

            if (!account) {
                return res.status(401).json({
                    success: false,
                    message: "Please sign in first.",
                });
            }

            if (account.isBlocked === true) {
                return res.status(403).json({
                    success: false,
                    message: "Your account is blocked.",
                });
            }

            if (account.roleSelectionPending === true) {
                return res.status(403).json({
                    success: false,
                    message: "Complete your account role selection first.",
                });
            }

            if (!allowedRoles.includes(account.role)) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have permission to perform this action.",
                });
            }

            next();
        };
    }

    function requireOrderCustomer(req, res, next) {
        const account = req.account;

        if (
            account.isBlocked === true ||
            account.roleSelectionPending === true ||
            !["customer", "vendor"].includes(account.role)
        ) {
            return res.status(403).json({
                success: false,
                message: "This account cannot access customer orders.",
            });
        }

        next();
    }


    // Only these application API endpoints are public.
    const publicApiReads = new Set([
        "/menu",
        "/menu/featured",
    ]);

    app.use("/api", (req, res, next) => {
        // Same-origin browser mutations only. JWT checks remain mandatory even
        // if a caller sends a forged or absent Origin header.
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
            const origin = req.get("origin");
            if (origin && origin !== new URL(clientUrl).origin) {
                return res.status(403).json({
                    success: false,
                    message: "Request origin is not allowed.",
                });
            }
        }

        const isPublicRead =
            ["GET", "HEAD"].includes(req.method) &&
            publicApiReads.has(req.path);

        if (isPublicRead) {
            return next();
        }

        return requireAccount(req, res, next);
    });

    // Apply role checks to every route under these prefixes.
    app.use("/api/vendor", requireRole("vendor"));
    app.use("/api/admin", requireRole("admin"));
    app.use("/api/customer", requireRole("customer"));

    await registerReviews({ app, db, requireRole, requireOrderCustomer });

    // ==================================================
    // Onboarding
    // ==================================================

    app.get("/api/onboarding", requireAccount, (req, res) => {
        res.set("Cache-Control", "no-store");

        res.json({
            success: true,
            data: {
                name: req.account.name,
                role: req.account.role,
                roleSelectionPending:
                    req.account.roleSelectionPending === true,
            },
        });
    });

    app.post(
        "/api/onboarding/role",
        requireAccount,
        async (req, res, next) => {
            try {
                if (req.get("origin") !== new URL(clientUrl).origin) {
                    return res.status(403).json({
                        success: false,
                        message: "Request origin is not allowed.",
                    });
                }

                if (!req.is("application/json")) {
                    return res.status(415).json({
                        success: false,
                        message: "Send the request as JSON.",
                    });
                }

                // Accept only the one field used by onboarding. Neither an
                // account identifier nor an admin role can come from the client.
                const body = req.body;
                if (
                    !body ||
                    typeof body !== "object" ||
                    Array.isArray(body) ||
                    Object.keys(body).length !== 1 ||
                    !Object.prototype.hasOwnProperty.call(body, "role")
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Provide only the account role.",
                    });
                }

                const role = body.role;

                if (role !== "customer" && role !== "vendor") {
                    return res.status(400).json({
                        success: false,
                        message: "Choose Customer or Vendor.",
                    });
                }

                const result = await usersCollection.updateOne(
                    {
                        _id: req.account._id,
                        role: "customer",
                        roleSelectionPending: true,
                        isBlocked: { $ne: true },
                    },
                    {
                        $set: {
                            role,
                            roleSelectionPending: false,
                            updatedAt: new Date(),
                        },
                    }
                );

                if (result.modifiedCount !== 1) {
                    return res.status(409).json({
                        success: false,
                        message: "Role selection is unavailable or already completed.",
                    });
                }

                res.json({
                    success: true,
                    message: "Your account role has been saved.",
                    data: {
                        role,
                        roleSelectionPending: false,
                    },
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // ==================================================
    // Profile name
    // ==================================================

    app.patch("/api/profile", requireAccount, async (req, res, next) => {
        try {
            if (req.get("origin") !== new URL(clientUrl).origin) {
                return res.status(403).json({
                    success: false,
                    message: "Request origin is not allowed.",
                });
            }

            if (!req.is("application/json")) {
                return res.status(415).json({
                    success: false,
                    message: "Send the request as JSON.",
                });
            }

            const body = req.body;

            if (
                !body ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                Object.keys(body).some((key) => key !== "name")
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Only your name can be updated here.",
                });
            }

            const name =
                typeof body.name === "string" ? body.name.trim() : "";

            if (name.length < 2 || name.length > 80) {
                return res.status(400).json({
                    success: false,
                    message: "Name must contain 2–80 characters.",
                });
            }

            const result = await usersCollection.updateOne(
                {
                    _id: req.account._id,
                    isBlocked: { $ne: true },
                },
                {
                    $set: {
                        name,
                        updatedAt: new Date(),
                    },
                }
            );

            if (result.matchedCount !== 1) {
                return res.status(403).json({
                    success: false,
                    message: "Your profile could not be updated.",
                });
            }

            res.json({
                success: true,
                message: "Profile updated successfully.",
                data: { name },
            });
        } catch (error) {
            next(error);
        }
    });

    // ==================================================
    // Profile image upload
    // ==================================================

    const receiveProfileImage = multer({
        storage: multer.memoryStorage(),

        limits: {
            fileSize: 2 * 1024 * 1024,
            files: 1,
            fields: 0,
            parts: 2,
        },

        fileFilter(req, file, callback) {
            const allowedTypes = [
                "image/jpeg",
                "image/png",
                "image/webp",
            ];

            if (!allowedTypes.includes(file.mimetype)) {
                return callback(
                    new Error("Please select a JPG, PNG, or WebP image.")
                );
            }

            callback(null, true);
        },
    }).single("image");

    function checkImageUploadRequest(req, res, next) {
        if (req.get("origin") !== new URL(clientUrl).origin) {
            return res.status(403).json({
                success: false,
                message: "This request is not allowed.",
            });
        }

        if (!process.env.IMGBB_API_KEY?.trim()) {
            return res.status(503).json({
                success: false,
                message: "Image uploads are not configured yet.",
            });
        }

        if (!req.is("multipart/form-data")) {
            return res.status(415).json({
                success: false,
                message: "Please send the image as form data.",
            });
        }

        next();
    }

    function parseProfileImage(req, res, next) {
        receiveProfileImage(req, res, (error) => {
            if (error) {
                const tooLarge = error.code === "LIMIT_FILE_SIZE";

                let message = "Please upload one JPG, PNG, or WebP image.";

                if (tooLarge) {
                    message = "Your profile image must be 2 MB or smaller.";
                } else if (!(error instanceof multer.MulterError)) {
                    message = "Please select a valid JPG, PNG, or WebP image.";
                }

                return res.status(tooLarge ? 413 : 400).json({
                    success: false,
                    message,
                });
            }

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Please select a profile image.",
                });
            }

            next();
        });
    }

    app.post(
        "/api/profile/image",
        requireAccount,
        checkImageUploadRequest,
        parseProfileImage,
        async (req, res, next) => {
            let processedImage;

            try {
                const image = sharp(req.file.buffer, {
                    limitInputPixels: 20_000_000,
                    failOn: "error",
                });

                const metadata = await image.metadata();

                if (
                    !["jpeg", "png", "webp"].includes(metadata.format) ||
                    (metadata.pages ?? 1) > 1
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Use a non-animated JPG, PNG, or WebP image.",
                    });
                }

                processedImage = await image
                    .rotate()
                    .resize(400, 400, {
                        fit: "cover",
                        position: "centre",
                        withoutEnlargement: true,
                    })
                    .webp({ quality: 85 })
                    .toBuffer();
            } catch {
                return res.status(400).json({
                    success: false,
                    message:
                        "This image could not be processed. Try a smaller JPG, PNG, or WebP image.",
                });
            }

            let imageUrl;

            try {
                const uploadBody = new FormData();

                uploadBody.append("key", process.env.IMGBB_API_KEY.trim());
                uploadBody.append("image", processedImage.toString("base64"));

                const uploadResponse = await fetch(
                    "https://api.imgbb.com/1/upload",
                    {
                        method: "POST",
                        body: uploadBody,
                        signal: AbortSignal.timeout(20_000),
                    }
                );

                const uploadResult = await uploadResponse.json();

                if (!uploadResponse.ok || uploadResult.success !== true) {
                    console.error("ImgBB rejected the upload:", {
                        status: uploadResponse.status,
                        message:
                            uploadResult.error?.message ||
                            uploadResult.data?.error?.message ||
                            "No error message returned",
                    });
                }

                if (
                    !uploadResponse.ok ||
                    uploadResult.success !== true ||
                    typeof uploadResult.data?.url !== "string"
                ) {
                    throw new Error("Image hosting failed.");
                }

                const uploadedUrl = new URL(uploadResult.data.url);

                if (uploadedUrl.protocol !== "https:") {
                    throw new Error("Invalid image URL.");
                }

                imageUrl = uploadedUrl.href;
            } catch (error) {
                console.error("Profile image upload failed:", {
                    name: error?.name,
                    message: error?.message,
                    networkCode: error?.cause?.code,
                });

                const timedOut = error?.name === "TimeoutError";

                return res.status(timedOut ? 504 : 502).json({
                    success: false,
                    message: timedOut
                        ? "Image upload timed out. Please try again."
                        : "The image service could not complete your upload. Please try again.",
                });
            }

            try {
                const result = await usersCollection.updateOne(
                    {
                        _id: req.account._id,
                        isBlocked: { $ne: true },
                    },
                    {
                        $set: {
                            image: imageUrl,
                            updatedAt: new Date(),
                        },
                    }
                );

                if (result.matchedCount !== 1) {
                    return res.status(403).json({
                        success: false,
                        message: "Your account cannot update its profile image.",
                    });
                }

                return res.status(200).json({
                    success: true,
                    message: "Profile image updated successfully.",
                    data: {
                        image: imageUrl,
                    },
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // ==================================================
    // Menu helpers
    // ==================================================

    function activeVendorStages() {
        return [
            {
                $lookup: {
                    from: "users",
                    let: { vendorId: { $convert: { input: "$vendorId", to: "string", onError: null, onNull: null } } },
                    pipeline: [
                        {
                            $match: {
                                role: "vendor", isBlocked: { $ne: true }, roleSelectionPending: { $ne: true },
                                $expr: { $eq: [{ $toString: "$_id" }, "$$vendorId"] }
                            }
                        },
                        { $set: { vendorIsPremium: premiumExpression() } },
                        {
                            $lookup: {
                                from: "menuItems", let: { ownerId: { $toString: "$_id" } },
                                pipeline: [
                                    {
                                        $match: {
                                            isAvailable: true, status: { $in: ["pending", "approved"] },
                                            $expr: { $eq: [{ $toString: "$vendorId" }, "$$ownerId"] }
                                        }
                                    },
                                    { $sort: { createdAt: 1, _id: 1 } }, { $limit: 3 }, { $project: { _id: 1 } }
                                ], as: "freeSlots"
                            }
                        },
                        { $project: { name: 1, image: 1, vendorIsPremium: 1, freeSlots: 1 } },
                        { $limit: 1 }
                    ], as: "vendor"
                }
            },
            { $unwind: "$vendor" },
            {
                $match: {
                    $expr: {
                        $or: [
                            "$vendor.vendorIsPremium", { $in: ["$_id", "$vendor.freeSlots._id"] }
                        ]
                    }
                }
            },
            {
                $set: {
                    vendorId: { $toString: "$vendor._id" }, vendorName: "$vendor.name",
                    vendorImage: { $ifNull: ["$vendor.image", null] }, vendorIsPremium: "$vendor.vendorIsPremium"
                }
            }
        ];
    }

    const publicMenuProjection = {
        averageRating: 1, reviewCount: 1, restaurantAverageRating: 1, restaurantReviewCount: 1,
        _id: 1,
        itemName: 1,
        description: 1,
        category: 1,
        price: 1,
        location: 1,
        images: 1,
        vendorId: 1,
        vendorName: 1,
        vendorImage: 1,
        vendorIsPremium: 1,
        createdAt: 1,
    };

    // ==================================================
    // Health endpoint
    // ==================================================

    app.get("/", (req, res) => {
        res.json({
            success: true,
            message: "PizzaHub server is running.",
        });
    });

    // ==================================================
    // Featured menu
    // ==================================================

    app.get("/api/menu/featured", async (req, res, next) => {
        try {
            res.set("Cache-Control", "no-store");

            const items = await menuItemsCollection
                .aggregate([
                    {
                        $match: {
                            status: "approved",
                            isAvailable: true,
                        },
                    },
                    ...activeVendorStages(),
                    { $sort: { vendorIsPremium: -1, createdAt: -1, _id: -1 } },
                    { $limit: 6 },
                    ...ratingStages(),
                    { $project: publicMenuProjection },
                ])
                .toArray();

            return res.json({
                success: true,
                data: items,
            });
        } catch (error) {
            next(error);
        }
    });

    // ==================================================
    // Item details
    // ==================================================

    app.get("/api/menu/:id", requireAccount, async (req, res, next) => {
        try {
            res.set("Cache-Control", "no-store");

            const { id } = req.params;

            if (!/^[a-fA-F0-9]{24}$/.test(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid menu item ID.",
                });
            }

            const [item] = await menuItemsCollection.aggregate([
                { $match: { _id: new ObjectId(id), status: "approved", isAvailable: true } },
                ...activeVendorStages(),
                ...ratingStages(),
                { $project: publicMenuProjection },
            ]).toArray();
            if (!item) return res.status(404).json({ success: false, message: "This item or its vendor is unavailable." });
            return res.json({ success: true, data: item });

        } catch (error) {
            next(error);
        }
    });

    // ==================================================
    // Public menu: search, filters, sorting, pagination
    // ==================================================

    app.get("/api/menu", async (req, res, next) => {
        try {
            res.set("Cache-Control", "no-store");

            function readQuery(name, fallback = "") {
                const value = req.query[name];

                if (value === undefined) return fallback;

                if (typeof value !== "string" || value.length > 100) {
                    throw new Error("INVALID_MENU_QUERY");
                }

                return value.trim();
            }

            function escapeSearch(value) {
                return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            }

            const search = readQuery("search");
            const category = readQuery("category");
            const location = readQuery("location");
            const sort = readQuery("sort", "newest");
            const pageText = readQuery("page", "1");

            const allowedCategories = [
                "classic-pizzas",
                "vegetarian-pizzas",
                "meat-lovers",
                "specialty-gourmet-pizzas",
                "sides-appetizers",
                "beverages-desserts",
            ];

            if (
                category &&
                category !== "all" &&
                !allowedCategories.includes(category)
            ) {
                throw new Error("INVALID_MENU_QUERY");
            }

            if (!["newest", "price-asc", "price-desc"].includes(sort)) {
                throw new Error("INVALID_MENU_QUERY");
            }

            if (!/^[1-9]\d*$/.test(pageText)) {
                throw new Error("INVALID_MENU_QUERY");
            }

            const page = Number(pageText);
            const limit = 12;

            if (!Number.isSafeInteger(page) || page > 10000) {
                throw new Error("INVALID_MENU_QUERY");
            }

            const filter = {
                status: "approved",
                isAvailable: true,
            };

            if (search) {
                filter.itemName = {
                    $regex: escapeSearch(search),
                    $options: "i",
                };
            }

            if (category && category !== "all") {
                filter.category = category;
            }

            if (location && location !== "all") {
                filter.location = {
                    $regex: escapeSearch(location),
                    $options: "i",
                };
            }

            const sortOptions =
                sort === "price-asc"
                    ? { price: 1, _id: 1 }
                    : sort === "price-desc"
                        ? { price: -1, _id: -1 }
                        : { createdAt: -1, _id: -1 };

            const [result] = await menuItemsCollection
                .aggregate([
                    { $match: filter },
                    ...activeVendorStages(),
                    {
                        $facet: {
                            items: [
                                { $sort: sortOptions },
                                { $skip: (page - 1) * limit },
                                { $limit: limit },
                                ...ratingStages(),
                                { $project: publicMenuProjection },
                            ],
                            totalCount: [{ $count: "total" }],
                        },
                    },
                ])
                .toArray();

            const total = result?.totalCount?.[0]?.total ?? 0;

            return res.json({
                success: true,
                data: result?.items ?? [],
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            if (error.message === "INVALID_MENU_QUERY") {
                return res.status(400).json({
                    success: false,
                    message: "Invalid menu filters or page number.",
                });
            }

            next(error);
        }
    });

    // ==================================================
    // Place an order
    // ==================================================

    app.post("/api/orders", requireAccount, async (req, res, next) => {
        try {
            res.set("Cache-Control", "no-store");

            if (req.get("origin") !== new URL(clientUrl).origin) {
                return res.status(403).json({
                    success: false,
                    message: "This request is not allowed.",
                });
            }

            if (!req.is("application/json")) {
                return res.status(415).json({
                    success: false,
                    message: "Please send the order as JSON.",
                });
            }

            const account = req.account;

            if (account.roleSelectionPending === true) {
                return res.status(403).json({
                    success: false,
                    message: "Complete your account role selection before ordering.",
                });
            }

            if (!["customer", "vendor"].includes(account.role)) {
                return res.status(403).json({
                    success: false,
                    message: "This account cannot place customer orders.",
                });
            }

            const body = req.body;

            if (!body || typeof body !== "object" || Array.isArray(body)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid order data.",
                });
            }

            const allowedFields = [
                "itemId",
                "orderDate",
                "quantity",
                "deliveryAddress",
                "message",
            ];

            if (Object.keys(body).some((key) => !allowedFields.includes(key))) {
                return res.status(400).json({
                    success: false,
                    message: "The order contains unsupported fields.",
                });
            }

            const { itemId, orderDate } = body;
            const quantity = body.quantity ?? 1;

            if (typeof body.deliveryAddress !== "string") {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a delivery address.",
                });
            }

            const deliveryAddress = body.deliveryAddress.trim();

            if (
                deliveryAddress.length < 10 ||
                deliveryAddress.length > 500
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Delivery address must be between 10 and 500 characters.",
                });
            }

            if (
                body.message !== undefined &&
                typeof body.message !== "string"
            ) {
                return res.status(400).json({
                    success: false,
                    message: "The order message must be text.",
                });
            }

            const message = (body.message ?? "").trim();

            if (message.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Your message must be 500 characters or fewer.",
                });
            }

            if (
                typeof itemId !== "string" ||
                !/^[a-fA-F0-9]{24}$/.test(itemId)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid menu item ID.",
                });
            }

            if (
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 20
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Quantity must be a whole number between 1 and 20.",
                });
            }

            if (
                typeof orderDate !== "string" ||
                !/^\d{4}-\d{2}-\d{2}$/.test(orderDate)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Choose a valid order date.",
                });
            }

            const parsedDate = new Date(`${orderDate}T00:00:00.000Z`);

            if (
                !Number.isFinite(parsedDate.getTime()) ||
                parsedDate.toISOString().slice(0, 10) !== orderDate
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Choose a valid calendar date.",
                });
            }

            const dateParts = new Intl.DateTimeFormat("en-US", {
                timeZone: "Asia/Dhaka",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            }).formatToParts(new Date());

            const getPart = (type) =>
                dateParts.find((part) => part.type === type).value;

            const today =
                `${getPart("year")}-${getPart("month")}-${getPart("day")}`;

            if (orderDate < today) {
                return res.status(400).json({
                    success: false,
                    message: "You cannot place an order for a past date.",
                });
            }

            const [item] = await menuItemsCollection
                .aggregate([
                    {
                        $match: {
                            _id: new ObjectId(itemId),
                            status: "approved",
                            isAvailable: true,
                        },
                    },
                    ...activeVendorStages(),
                    {
                        $project: {
                            itemName: 1,
                            price: 1,
                            images: 1,
                            location: 1,
                            vendorId: 1,
                            vendorName: 1,
                        },
                    },
                ])
                .toArray();

            if (!item) {
                return res.status(404).json({
                    success: false,
                    message: "This item or its vendor is no longer available.",
                });
            }

            const customerId = String(account._id);

            if (String(item.vendorId) === customerId) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot order your own menu item.",
                });
            }

            // Use the current database price, not a browser-supplied total.
            const unitPriceMinor = Math.round(item.price * 100);

            if (
                typeof item.price !== "number" ||
                !Number.isFinite(item.price) ||
                item.price <= 0 ||
                !Number.isSafeInteger(unitPriceMinor) ||
                unitPriceMinor < 1 ||
                !Number.isSafeInteger(unitPriceMinor * quantity)
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "This item's price needs to be corrected before ordering.",
                });
            }

            const totalPriceMinor = unitPriceMinor * quantity;
            const now = new Date();

            const order = {
                vendorId: String(item.vendorId),
                customerId,
                customerName: account.name,
                itemId: String(item._id),
                itemName: item.itemName,
                itemImage: Array.isArray(item.images)
                    ? item.images[0] ?? null
                    : null,
                vendorName: item.vendorName,
                location: item.location,
                orderDate,
                deliveryAddress,
                message,
                quantity,
                currency: "BDT",
                unitPriceMinor,
                totalPriceMinor,
                status: "pending",
                createdAt: now,
                updatedAt: now,
            };

            const result = await ordersCollection.insertOne(order);

            return res.status(201).json({
                success: true,
                message: "Order placed successfully. Waiting for vendor approval.",
                data: {
                    _id: String(result.insertedId),
                    itemName: order.itemName,
                    orderDate: order.orderDate,
                    quantity: order.quantity,
                    totalPrice: totalPriceMinor / 100,
                    currency: order.currency,
                    status: order.status,
                },
            });
        } catch (error) {
            if (error.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message:
                        "You already have a pending or accepted order for this item on that date.",
                });
            }

            next(error);
        }
    });

    // ==================================================
    // Customer overview and My Orders
    // ==================================================

    app.get(
        "/api/orders/mine",
        requireAccount,
        requireOrderCustomer,
        async (req, res, next) => {
            try {
                res.set("Cache-Control", "no-store");

                const rawPage = req.query.page ?? "1";

                if (
                    typeof rawPage !== "string" ||
                    !/^[1-9]\d*$/.test(rawPage) ||
                    !Number.isSafeInteger(Number(rawPage)) ||
                    Number(rawPage) > 100000
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid page number.",
                    });
                }

                const page = Number(rawPage);
                const pageSize = 10;
                const customerId = String(req.account._id);

                const [result] = await ordersCollection
                    .aggregate([
                        { $match: { customerId } },
                        { $sort: { createdAt: -1, _id: -1 } },
                        {
                            $facet: {
                                summary: [
                                    {
                                        $group: {
                                            _id: null,

                                            total: { $sum: 1 },

                                            pending: {
                                                $sum: {
                                                    $cond: [
                                                        { $eq: ["$status", "pending"] },
                                                        1,
                                                        0,
                                                    ],
                                                },
                                            },

                                            accepted: {
                                                $sum: {
                                                    $cond: [
                                                        { $eq: ["$status", "accepted"] },
                                                        1,
                                                        0,
                                                    ],
                                                },
                                            },

                                            rejected: {
                                                $sum: {
                                                    $cond: [
                                                        { $eq: ["$status", "rejected"] },
                                                        1,
                                                        0,
                                                    ],
                                                },
                                            },

                                            cancelled: {
                                                $sum: {
                                                    $cond: [
                                                        { $eq: ["$status", "cancelled"] },
                                                        1,
                                                        0,
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                    { $project: { _id: 0 } },
                                ],

                                orders: [
                                    { $skip: (page - 1) * pageSize },
                                    { $limit: pageSize },
                                    {
                                        $project: {
                                            _id: 1,
                                            itemName: 1,
                                            itemImage: 1,
                                            vendorName: 1,
                                            location: 1,
                                            orderDate: 1,
                                            deliveryAddress: 1,
                                            message: 1,
                                            status: 1,
                                            quantity: 1,
                                            unitPriceMinor: 1,
                                            totalPriceMinor: 1,
                                            createdAt: 1,
                                        },
                                    },
                                ],
                            },
                        },
                    ])
                    .toArray();

                const summary = result.summary[0] ?? {
                    total: 0,
                    pending: 0,
                    accepted: 0,
                    rejected: 0,
                    cancelled: 0,
                };

                return res.json({
                    success: true,
                    data: {
                        summary,
                        orders: result.orders.map((order) => ({
                            ...order,
                            _id: String(order._id),
                        })),
                        pagination: {
                            page,
                            pageSize,
                            totalPages: Math.max(
                                1,
                                Math.ceil(summary.total / pageSize)
                            ),
                        },
                    },
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // ==================================================
    // Cancel the signed-in customer's pending order
    // ==================================================

    app.patch(
        "/api/orders/:id/cancel",
        requireAccount,
        requireOrderCustomer,
        async (req, res, next) => {
            try {
                res.set("Cache-Control", "no-store");

                if (req.get("origin") !== new URL(clientUrl).origin) {
                    return res.status(403).json({
                        success: false,
                        message: "This request is not allowed.",
                    });
                }

                // Cancellation is an action without an editable payload.
                // Reject an unexpected JSON body rather than silently accepting
                // user-controlled account, owner or order-status fields.
                if (
                    req.body !== undefined &&
                    (typeof req.body !== "object" ||
                        req.body === null ||
                        Array.isArray(req.body) ||
                        Object.keys(req.body).length !== 0)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Order cancellation does not accept request fields.",
                    });
                }

                const { id } = req.params;

                if (!/^[a-fA-F0-9]{24}$/.test(id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid order ID.",
                    });
                }

                const ownershipFilter = {
                    _id: new ObjectId(id),
                    customerId: String(req.account._id),
                };

                const now = new Date();

                // Check ownership AND pending status in the same update.
                const result = await ordersCollection.updateOne(
                    {
                        ...ownershipFilter,
                        status: "pending",
                    },
                    {
                        $set: {
                            status: "cancelled",
                            cancelledAt: now,
                            updatedAt: now,
                        },
                    }
                );

                if (result.modifiedCount === 1) {
                    return res.json({
                        success: true,
                        message: "Order cancelled successfully.",
                        data: {
                            _id: id,
                            status: "cancelled",
                        },
                    });
                }

                const order = await ordersCollection.findOne(
                    ownershipFilter,
                    { projection: { _id: 1 } }
                );

                if (!order) {
                    return res.status(404).json({
                        success: false,
                        message: "Order not found.",
                    });
                }

                return res.status(409).json({
                    success: false,
                    message:
                        "Only pending orders can be cancelled. Refresh to see the latest status.",
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // Vendor overview
    app.get(
        "/api/vendor/overview",
        requireAccount,
        requireRole("vendor"),
        async (req, res, next) => {
            try {
                res.set("Cache-Control", "no-store");

                // Support documents that store vendorId as a string or ObjectId.
                const vendorIds = [String(req.account._id)];

                if (req.account._id instanceof ObjectId) {
                    vendorIds.push(req.account._id);
                }

                const ownershipFilter = {
                    vendorId: { $in: vendorIds },
                };

                const [
                    totalMenuItems,
                    activeMenuItems,
                    pendingCustomerOrders,
                    acceptedOrders,
                ] = await Promise.all([
                    menuItemsCollection.countDocuments(ownershipFilter),

                    // Available pending/approved items occupy active-item slots.
                    menuItemsCollection.countDocuments({
                        ...ownershipFilter,
                        status: { $in: ["pending", "approved"] },
                        isAvailable: true,
                    }),

                    ordersCollection.countDocuments({
                        ...ownershipFilter,
                        status: "pending",
                    }),

                    ordersCollection.countDocuments({
                        ...ownershipFilter,
                        status: "accepted",
                    }),
                ]);

                return res.json({
                    success: true,
                    data: {
                        overview: {
                            totalMenuItems,
                            activeMenuItems,
                            pendingCustomerOrders,
                            acceptedOrders,
                        },

                        subscription: billing.subscriptionView(req.account),
                    },
                });
            } catch (error) {
                next(error);
            }
        }
    );


    // ==================================================
    // Vendor: Create menu item
    // ==================================================

    const menuCategories = [
        "classic-pizzas",
        "vegetarian-pizzas",
        "meat-lovers",
        "specialty-gourmet-pizzas",
        "sides-appetizers",
        "beverages-desserts",
    ];

    const receiveMenuImage = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: 2 * 1024 * 1024,
            files: 1,
            fields: 5,
            parts: 6,
            fieldSize: 10_000,
        },
        fileFilter(req, file, callback) {
            if (
                !["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)
            ) {
                return callback(
                    new Error("Please upload a JPG, PNG, or WebP image.")
                );
            }

            callback(null, true);
        },
    }).single("image");

    function checkMenuCreateRequest(req, res, next) {
        if (req.get("origin") !== new URL(clientUrl).origin) {
            return res.status(403).json({
                success: false,
                message: "This request is not allowed.",
            });
        }

        if (!process.env.IMGBB_API_KEY?.trim()) {
            return res.status(503).json({
                success: false,
                message: "Image uploads are not configured.",
            });
        }

        if (!req.is("multipart/form-data")) {
            return res.status(415).json({
                success: false,
                message: "Submit the menu item with an image file.",
            });
        }

        next();
    }

    function parseMenuUpload(req, res, next) {
        receiveMenuImage(req, res, (error) => {
            if (error) {
                return res
                    .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
                    .json({
                        success: false,
                        message:
                            error.code === "LIMIT_FILE_SIZE"
                                ? "The image must be 2 MB or smaller."
                                : "Upload one JPG, PNG, or WebP image with the required fields.",
                    });
            }

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "A menu item image is required.",
                });
            }

            next();
        });
    }

    function menuCreateError(status, message) {
        const error = new Error(message);
        error.httpStatus = status;
        return error;
    }

    app.post(
        "/api/vendor/menu",
        requireAccount,
        requireRole("vendor"),
        checkMenuCreateRequest,
        parseMenuUpload,
        async (req, res, next) => {
            let databaseSession;

            try {
                res.set("Cache-Control", "no-store");

                const allowedFields = [
                    "itemName",
                    "category",
                    "description",
                    "price",
                    "location",
                ];

                const body = req.body;

                if (
                    !body ||
                    allowedFields.some((key) => typeof body[key] !== "string") ||
                    Object.keys(body).some((key) => !allowedFields.includes(key))
                ) {
                    throw menuCreateError(
                        400,
                        "Complete all required fields. Unsupported fields are not allowed."
                    );
                }

                const itemName = body.itemName.trim();
                const category = body.category.trim();
                const description = body.description.trim();
                const location = body.location.trim();
                const priceText = body.price.trim();

                if (itemName.length < 2 || itemName.length > 100) {
                    throw menuCreateError(
                        400,
                        "Item name must contain 2–100 characters."
                    );
                }

                if (!menuCategories.includes(category)) {
                    throw menuCreateError(400, "Choose a valid category.");
                }

                if (description.length < 10 || description.length > 2000) {
                    throw menuCreateError(
                        400,
                        "Description must contain 10–2000 characters."
                    );
                }

                if (location.length < 2 || location.length > 150) {
                    throw menuCreateError(
                        400,
                        "Location must contain 2–150 characters."
                    );
                }

                if (!/^\d+(?:\.\d{1,2})?$/.test(priceText)) {
                    throw menuCreateError(
                        400,
                        "Enter a valid price with at most two decimal places."
                    );
                }

                const price = Number(priceText);
                const priceMinor = Math.round(price * 100);

                if (
                    !Number.isFinite(price) ||
                    price <= 0 ||
                    price > 1_000_000 ||
                    !Number.isSafeInteger(priceMinor) ||
                    priceMinor < 1
                ) {
                    throw menuCreateError(
                        400,
                        "Price must be between ৳0.01 and ৳1,000,000."
                    );
                }

                const vendorId = String(req.account._id);
                const vendorIds = [vendorId];

                if (req.account._id instanceof ObjectId) {
                    vendorIds.push(req.account._id);
                }

                const activeFilter = {
                    vendorId: { $in: vendorIds },
                    status: { $in: ["pending", "approved"] },
                    isAvailable: true,
                };

                // Read the verified, unexpired subscription.
                const activeItemLimit = await billing.limitFor(req.account);

                // Early check avoids an unnecessary image upload.
                // The authoritative check is repeated inside the transaction.
                const currentCount =
                    await menuItemsCollection.countDocuments(activeFilter);

                if (currentCount >= activeItemLimit) {
                    throw menuCreateError(
                        409,
                        "Your Free plan allows up to 3 active items."
                    );
                }

                let processedImage;

                try {
                    const image = sharp(req.file.buffer, {
                        limitInputPixels: 20_000_000,
                        failOn: "error",
                    });

                    const metadata = await image.metadata();

                    if (
                        !["jpeg", "png", "webp"].includes(metadata.format) ||
                        (metadata.pages ?? 1) > 1
                    ) {
                        throw new Error("Unsupported image.");
                    }

                    processedImage = await image
                        .rotate()
                        .resize({
                            width: 1600,
                            height: 1600,
                            fit: "inside",
                            withoutEnlargement: true,
                        })
                        .webp({ quality: 85 })
                        .toBuffer();
                } catch {
                    throw menuCreateError(
                        400,
                        "Choose a valid, non-animated JPG, PNG, or WebP image."
                    );
                }

                let imageUrl;

                try {
                    const uploadBody = new FormData();

                    uploadBody.append("key", process.env.IMGBB_API_KEY.trim());
                    uploadBody.append("image", processedImage.toString("base64"));

                    const response = await fetch(
                        "https://api.imgbb.com/1/upload",
                        {
                            method: "POST",
                            body: uploadBody,
                            signal: AbortSignal.timeout(20_000),
                        }
                    );

                    const result = await response.json();

                    if (
                        !response.ok ||
                        result?.success !== true ||
                        typeof result.data?.url !== "string"
                    ) {
                        throw new Error("Upload failed.");
                    }

                    const url = new URL(result.data.url);

                    if (url.protocol !== "https:") {
                        throw new Error("Invalid image URL.");
                    }

                    imageUrl = url.href;
                } catch {
                    throw menuCreateError(
                        502,
                        "The image could not be uploaded. Please try again."
                    );
                }

                const now = new Date();

                const item = {
                    _id: new ObjectId(),
                    vendorId,
                    itemName,
                    category,
                    description,
                    price: priceMinor / 100,
                    location,
                    images: [imageUrl],
                    status: "pending",
                    isAvailable: true,
                    createdAt: now,
                    updatedAt: now,
                };

                databaseSession = client.startSession();

                await databaseSession.withTransaction(
                    async () => {
                        // Serialize menu-slot changes for this vendor.
                        // Other availability/resubmission routes must use this same
                        // transaction pattern when we implement them.
                        const vendorResult = await usersCollection.updateOne(
                            {
                                _id: req.account._id,
                                role: "vendor",
                                isBlocked: { $ne: true },
                                roleSelectionPending: { $ne: true },
                            },
                            {
                                $inc: { menuWriteVersion: 1 },
                            },
                            { session: databaseSession }
                        );

                        if (vendorResult.matchedCount !== 1) {
                            throw menuCreateError(
                                403,
                                "Your account cannot create menu items."
                            );
                        }

                        const activeCount = await menuItemsCollection.countDocuments(
                            activeFilter,
                            { session: databaseSession }
                        );

                        if (activeCount >= await billing.limitFor(req.account, databaseSession)) {
                            throw menuCreateError(
                                409,
                                "Your Free plan allows up to 3 active items."
                            );
                        }

                        await menuItemsCollection.insertOne(item, {
                            session: databaseSession,
                        });
                    },
                    {
                        readConcern: { level: "snapshot" },
                        writeConcern: { w: "majority" },
                        readPreference: "primary",
                    }
                );

                return res.status(201).json({
                    success: true,
                    message: "Menu item submitted. Waiting for admin approval.",
                    data: {
                        _id: String(item._id),
                        itemName: item.itemName,
                        status: item.status,
                        isAvailable: item.isAvailable,
                    },
                });
            } catch (error) {
                if (error.httpStatus) {
                    return res.status(error.httpStatus).json({
                        success: false,
                        message: error.message,
                    });
                }

                next(error);
            } finally {
                if (databaseSession) {
                    await databaseSession.endSession();
                }
            }
        }
    );

    // ---------- Vendor menu management ----------

    function vendorMenuIds(account) {
        const ids = [String(account._id)];

        if (account._id instanceof ObjectId) {
            ids.push(account._id);
        }

        return ids;
    }

    function vendorMenuFilter(account, itemId) {
        return {
            _id: new ObjectId(itemId),
            vendorId: { $in: vendorMenuIds(account) },
        };
    }

    function validateVendorMenuId(req, res, next) {
        if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid menu item ID.",
            });
        }

        next();
    }

    function protectVendorMenuMutation(req, res, next) {
        res.set("Cache-Control", "no-store");

        if (req.get("origin") !== new URL(clientUrl).origin) {
            return res.status(403).json({
                success: false,
                message: "This request is not allowed.",
            });
        }

        next();
    }

    // Unlike the create route, a replacement image is optional.
    function parseOptionalMenuImage(req, res, next) {
        if (!req.is("multipart/form-data")) {
            return res.status(415).json({
                success: false,
                message: "Submit the item using form data.",
            });
        }

        receiveMenuImage(req, res, (error) => {
            if (error) {
                return res
                    .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
                    .json({
                        success: false,
                        message:
                            error.code === "LIMIT_FILE_SIZE"
                                ? "The image must be 2 MB or smaller."
                                : "Upload one JPEG, PNG, or WebP image with valid item fields.",
                    });
            }

            next();
        });
    }

    function publicVendorMenuItem(item) {
        return {
            _id: String(item._id),
            itemName: item.itemName,
            category: item.category,
            description: item.description,
            price: item.price,
            location: item.location,
            images: Array.isArray(item.images) ? item.images : [],
            status: item.status,
            isAvailable: item.isAvailable === true,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
        };
    }

    function validateMenuEdit(body) {
        const allowedFields = [
            "itemName",
            "category",
            "description",
            "price",
            "location",
        ];

        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).some((key) => !allowedFields.includes(key)) ||
            allowedFields.some((key) => typeof body[key] !== "string")
        ) {
            throw menuCreateError(400, "Provide all required item fields.");
        }

        const itemName = body.itemName.trim();
        const category = body.category.trim();
        const description = body.description.trim();
        const location = body.location.trim();
        const priceText = body.price.trim();

        if (itemName.length < 2 || itemName.length > 100) {
            throw menuCreateError(400, "Item name must contain 2–100 characters.");
        }

        if (!menuCategories.includes(category)) {
            throw menuCreateError(400, "Choose a valid category.");
        }

        if (description.length < 10 || description.length > 2000) {
            throw menuCreateError(
                400,
                "Description must contain 10–2000 characters."
            );
        }

        if (location.length < 2 || location.length > 150) {
            throw menuCreateError(400, "Location must contain 2–150 characters.");
        }

        const price = Number(priceText);
        const priceMinor = Math.round(price * 100);

        if (
            !/^\d+(?:\.\d{1,2})?$/.test(priceText) ||
            !Number.isFinite(price) ||
            price <= 0 ||
            price > 1_000_000 ||
            !Number.isSafeInteger(priceMinor) ||
            priceMinor < 1
        ) {
            throw menuCreateError(
                400,
                "Enter a price between 0.01 and 1,000,000 with up to two decimal places."
            );
        }

        return {
            itemName,
            category,
            description,
            price: priceMinor / 100,
            location,
        };
    }

    async function uploadReplacementMenuImage(file) {
        const apiKey = process.env.IMGBB_API_KEY;

        if (!apiKey) {
            throw menuCreateError(503, "Image uploads are currently unavailable.");
        }

        let imageBuffer;

        try {
            const metadata = await sharp(file.buffer, {
                limitInputPixels: 20_000_000,
            }).metadata();

            if (
                !["jpeg", "png", "webp"].includes(metadata.format) ||
                (metadata.pages ?? 1) > 1
            ) {
                throw new Error("Unsupported image.");
            }

            imageBuffer = await sharp(file.buffer, {
                limitInputPixels: 20_000_000,
            })
                .rotate()
                .resize({
                    width: 1600,
                    height: 1600,
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .webp({ quality: 85 })
                .toBuffer();
        } catch {
            throw menuCreateError(
                400,
                "Upload a valid, non-animated JPEG, PNG, or WebP image."
            );
        }

        const form = new FormData();
        form.append("key", apiKey);
        form.append("image", imageBuffer.toString("base64"));

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);

        try {
            const response = await fetch("https://api.imgbb.com/1/upload", {
                method: "POST",
                body: form,
                signal: controller.signal,
            });

            const result = await response.json();
            const imageUrl = result?.data?.url;

            if (
                !response.ok ||
                result.success !== true ||
                typeof imageUrl !== "string" ||
                new URL(imageUrl).protocol !== "https:"
            ) {
                throw new Error("Image upload failed.");
            }

            return imageUrl;
        } catch {
            throw menuCreateError(
                502,
                "Could not upload the replacement image. Please try again."
            );
        } finally {
            clearTimeout(timer);
        }
    }

    // Uses the same vendor lock as the create route.
    // All operations affecting active-item slots must use this protocol.
    async function withVendorMenuTransaction(account, operation) {
        const databaseSession = client.startSession();

        try {
            return await databaseSession.withTransaction(
                async () => {
                    const vendorResult = await usersCollection.updateOne(
                        {
                            _id: account._id,
                            role: "vendor",
                            isBlocked: { $ne: true },
                            roleSelectionPending: { $ne: true },
                        },
                        { $inc: { menuWriteVersion: 1 } },
                        { session: databaseSession }
                    );

                    if (vendorResult.matchedCount !== 1) {
                        throw menuCreateError(
                            403,
                            "Your account cannot manage menu items."
                        );
                    }

                    return operation(databaseSession);
                },
                {
                    readConcern: { level: "snapshot" },
                    writeConcern: { w: "majority" },
                    readPreference: "primary",
                }
            );
        } finally {
            await databaseSession.endSession();
        }
    }

    async function ensureMenuSlotAvailable(account, itemId, session) {
        const activeItemLimit = await billing.limitFor(account, session);

        const otherActiveItems = await menuItemsCollection.countDocuments(
            {
                _id: { $ne: itemId },
                vendorId: { $in: vendorMenuIds(account) },
                status: { $in: ["pending", "approved"] },
                isAvailable: true,
            },
            { session }
        );

        if (otherActiveItems >= activeItemLimit) {
            throw menuCreateError(
                409,
                "Your Free plan allows 3 active items. Make another item unavailable first."
            );
        }
    }

    function handleVendorMenuError(error, res, next) {
        if (Number.isInteger(error?.httpStatus)) {
            return res.status(error.httpStatus).json({
                success: false,
                message: error.message,
            });
        }

        next(error);
    }

    // List only the signed-in vendor's items.
    app.get(
        "/api/vendor/menu",
        requireAccount,
        requireRole("vendor"),
        async (req, res, next) => {
            try {
                res.set("Cache-Control", "no-store");

                const pageText = req.query.page ?? "1";

                if (
                    typeof pageText !== "string" ||
                    !/^[1-9]\d*$/.test(pageText) ||
                    Number(pageText) > 100_000
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid page number.",
                    });
                }

                const page = Number(pageText);
                const pageSize = 10;
                const ownership = {
                    vendorId: { $in: vendorMenuIds(req.account) },
                };

                const [result] = await menuItemsCollection
                    .aggregate([
                        { $match: ownership },
                        {
                            $facet: {
                                items: [
                                    { $sort: { createdAt: -1, _id: -1 } },
                                    { $skip: (page - 1) * pageSize },
                                    { $limit: pageSize },
                                    {
                                        $project: {
                                            itemName: 1,
                                            category: 1,
                                            description: 1,
                                            price: 1,
                                            location: 1,
                                            images: 1,
                                            status: 1,
                                            isAvailable: 1,
                                            createdAt: 1,
                                            updatedAt: 1,
                                        },
                                    },
                                ],
                                count: [{ $count: "total" }],
                            },
                        },
                    ])
                    .toArray();

                const total = result?.count[0]?.total ?? 0;

                return res.json({
                    success: true,
                    data: {
                        items: (result?.items ?? []).map(publicVendorMenuItem),
                        pagination: {
                            page,
                            pageSize,
                            total,
                            totalPages: Math.max(1, Math.ceil(total / pageSize)),
                        },
                    },
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // Vendor-only details, including pending and rejected items.
    app.get(
        "/api/vendor/menu/:id",
        requireAccount,
        requireRole("vendor"),
        validateVendorMenuId,
        async (req, res, next) => {
            try {
                res.set("Cache-Control", "no-store");

                const item = await menuItemsCollection.findOne(
                    vendorMenuFilter(req.account, req.params.id)
                );

                if (!item) {
                    return res.status(404).json({
                        success: false,
                        message: "Menu item not found.",
                    });
                }

                return res.json({
                    success: true,
                    data: publicVendorMenuItem(item),
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // Edit content. Every successful edit requires admin approval again.
    app.patch(
        "/api/vendor/menu/:id",
        requireAccount,
        requireRole("vendor"),
        validateVendorMenuId,
        protectVendorMenuMutation,
        parseOptionalMenuImage,
        async (req, res, next) => {
            try {
                const filter = vendorMenuFilter(req.account, req.params.id);
                const changes = validateMenuEdit(req.body);

                // Verify ownership before uploading anything.
                const existing = await menuItemsCollection.findOne(filter);

                if (!existing) {
                    throw menuCreateError(404, "Menu item not found.");
                }

                const replacementImage = req.file
                    ? await uploadReplacementMenuImage(req.file)
                    : null;

                await withVendorMenuTransaction(req.account, async (session) => {
                    // Re-read inside the transaction to handle concurrent changes.
                    const current = await menuItemsCollection.findOne(filter, {
                        session,
                    });

                    if (!current) {
                        throw menuCreateError(404, "Menu item not found.");
                    }

                    // Rejected -> pending may consume an active slot.
                    if (current.isAvailable === true) {
                        await ensureMenuSlotAvailable(
                            req.account,
                            current._id,
                            session
                        );
                    }

                    await menuItemsCollection.updateOne(
                        filter,
                        {
                            $set: {
                                ...changes,
                                ...(replacementImage
                                    ? { images: [replacementImage] }
                                    : {}),
                                status: "pending",
                                updatedAt: new Date(),
                            },
                        },
                        { session }
                    );
                });

                return res.json({
                    success: true,
                    message: "Item updated and submitted for admin approval.",
                });
            } catch (error) {
                handleVendorMenuError(error, res, next);
            }
        }
    );

    // Change availability without changing approval status.
    app.patch(
        "/api/vendor/menu/:id/availability",
        requireAccount,
        requireRole("vendor"),
        validateVendorMenuId,
        protectVendorMenuMutation,
        async (req, res, next) => {
            try {
                if (!req.is("application/json")) {
                    throw menuCreateError(415, "Send availability as JSON.");
                }

                const body = req.body;

                if (
                    !body ||
                    typeof body !== "object" ||
                    Array.isArray(body) ||
                    Object.keys(body).length !== 1 ||
                    typeof body.isAvailable !== "boolean"
                ) {
                    throw menuCreateError(
                        400,
                        "Provide only an isAvailable boolean."
                    );
                }

                const filter = vendorMenuFilter(req.account, req.params.id);

                await withVendorMenuTransaction(req.account, async (session) => {
                    const item = await menuItemsCollection.findOne(filter, {
                        session,
                    });

                    if (!item) {
                        throw menuCreateError(404, "Menu item not found.");
                    }

                    if (
                        body.isAvailable &&
                        ["pending", "approved"].includes(item.status)
                    ) {
                        await ensureMenuSlotAvailable(req.account, item._id, session);
                    }

                    await menuItemsCollection.updateOne(
                        filter,
                        {
                            $set: {
                                isAvailable: body.isAvailable,
                                updatedAt: new Date(),
                            },
                        },
                        { session }
                    );
                });

                return res.json({
                    success: true,
                    message: body.isAvailable
                        ? "Availability enabled. Only approved items appear to customers."
                        : "Item marked unavailable.",
                });
            } catch (error) {
                handleVendorMenuError(error, res, next);
            }
        }
    );

    // Delete only the vendor's own item.
    // Existing order snapshots are preserved.
    app.delete(
        "/api/vendor/menu/:id",
        requireAccount,
        requireRole("vendor"),
        validateVendorMenuId,
        protectVendorMenuMutation,
        async (req, res, next) => {
            try {
                const filter = vendorMenuFilter(req.account, req.params.id);

                await withVendorMenuTransaction(req.account, async (session) => {
                    const result = await menuItemsCollection.deleteOne(filter, {
                        session,
                    });

                    if (result.deletedCount !== 1) {
                        throw menuCreateError(404, "Menu item not found.");
                    }
                });

                return res.json({
                    success: true,
                    message: "Menu item deleted.",
                });
            } catch (error) {
                handleVendorMenuError(error, res, next);
            }
        }
    );

    // ---------- Vendor customer orders ----------

    // List orders belonging to the authenticated vendor.
    app.get(
        "/api/vendor/orders",
        requireAccount,
        requireRole("vendor"),
        async (req, res, next) => {
            try {
                res.set("Cache-Control", "no-store");

                const pageText = req.query.page ?? "1";

                if (
                    typeof pageText !== "string" ||
                    !/^[1-9]\d*$/.test(pageText) ||
                    Number(pageText) > 100_000
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid page number.",
                    });
                }

                const page = Number(pageText);
                const pageSize = 10;

                // Order creation stores vendorId as a string.
                const vendorId = String(req.account._id);

                const [result] = await ordersCollection
                    .aggregate([
                        {
                            $match: { vendorId },
                        },
                        {
                            $facet: {
                                orders: [
                                    {
                                        $sort: {
                                            createdAt: -1,
                                            _id: -1,
                                        },
                                    },
                                    { $skip: (page - 1) * pageSize },
                                    { $limit: pageSize },
                                    {
                                        $project: {
                                            customerName: 1,
                                            itemId: 1,
                                            itemName: 1,
                                            itemImage: 1,
                                            orderDate: 1,
                                            deliveryAddress: 1,
                                            message: 1,
                                            quantity: 1,
                                            currency: 1,
                                            unitPriceMinor: 1,
                                            totalPriceMinor: 1,
                                            status: 1,
                                            createdAt: 1,
                                            updatedAt: 1,
                                        },
                                    },
                                ],
                                summary: [
                                    {
                                        $group: {
                                            _id: null,
                                            total: { $sum: 1 },
                                            pending: {
                                                $sum: {
                                                    $cond: [{ $eq: ["$status", "pending"] }, 1, 0],
                                                },
                                            },
                                            accepted: {
                                                $sum: {
                                                    $cond: [{ $eq: ["$status", "accepted"] }, 1, 0],
                                                },
                                            },
                                            rejected: {
                                                $sum: {
                                                    $cond: [{ $eq: ["$status", "rejected"] }, 1, 0],
                                                },
                                            },
                                            cancelled: {
                                                $sum: {
                                                    $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0],
                                                },
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ])
                    .toArray();

                const counts = result?.summary[0];

                const summary = {
                    total: counts?.total ?? 0,
                    pending: counts?.pending ?? 0,
                    accepted: counts?.accepted ?? 0,
                    rejected: counts?.rejected ?? 0,
                    cancelled: counts?.cancelled ?? 0,
                };

                return res.json({
                    success: true,
                    data: {
                        summary,
                        orders: (result?.orders ?? []).map((order) => ({
                            ...order,
                            _id: String(order._id),
                        })),
                        pagination: {
                            page,
                            pageSize,
                            total: summary.total,
                            totalPages: Math.max(
                                1,
                                Math.ceil(summary.total / pageSize)
                            ),
                        },
                    },
                });
            } catch (error) {
                next(error);
            }
        }
    );

    // Accept or reject an owned pending order.
    // Ownership and pending status are checked in the same atomic update.
    app.patch(
        "/api/vendor/orders/:id/status",
        requireAccount,
        requireRole("vendor"),
        async (req, res, next) => {
            try {
                res.set("Cache-Control", "no-store");

                if (req.get("origin") !== new URL(clientUrl).origin) {
                    return res.status(403).json({
                        success: false,
                        message: "This request is not allowed.",
                    });
                }

                if (!req.is("application/json")) {
                    return res.status(415).json({
                        success: false,
                        message: "Send the order status as JSON.",
                    });
                }

                if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid order ID.",
                    });
                }

                const body = req.body;

                if (
                    !body ||
                    typeof body !== "object" ||
                    Array.isArray(body) ||
                    Object.keys(body).length !== 1 ||
                    !["accepted", "rejected"].includes(body.status)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Provide only a status of accepted or rejected.",
                    });
                }

                const ownership = {
                    _id: new ObjectId(req.params.id),
                    vendorId: String(req.account._id),
                };

                const now = new Date();

                const result = await ordersCollection.updateOne(
                    {
                        ...ownership,
                        status: "pending",
                    },
                    {
                        $set: {
                            status: body.status,
                            updatedAt: now,
                            respondedAt: now,
                        },
                    }
                );

                if (result.matchedCount !== 1) {
                    const existing = await ordersCollection.findOne(
                        ownership,
                        { projection: { _id: 1 } }
                    );

                    if (!existing) {
                        return res.status(404).json({
                            success: false,
                            message: "Order not found.",
                        });
                    }

                    return res.status(409).json({
                        success: false,
                        message:
                            "This order is no longer pending. Refresh to see its current status.",
                    });
                }

                return res.json({
                    success: true,
                    message:
                        body.status === "accepted"
                            ? "Order accepted successfully."
                            : "Order rejected successfully.",
                    data: {
                        _id: req.params.id,
                        status: body.status,
                        updatedAt: now,
                    },
                });
            } catch (error) {
                next(error);
            }
        }
    );

    billing.mountRoutes(app, requireAccount, requireRole);

    // ==================================================
    // Unknown routes
    // ==================================================

    app.use((req, res) => {
        res.status(404).json({
            success: false,
            message: "API route not found.",
        });
    });

    // ==================================================
    // Error handler
    // ==================================================

    app.use((error, req, res, next) => {
        if (res.headersSent) {
            return next(error);
        }

        if (error.type === "entity.parse.failed") {
            return res.status(400).json({
                success: false,
                message: "Invalid JSON request body.",
            });
        }

        if (error.type === "entity.too.large") {
            return res.status(413).json({
                success: false,
                message: "Request body is too large.",
            });
        }

        console.error("API error:", error.name);

        res.status(500).json({
            success: false,
            message: "Something went wrong. Please try again.",
        });
    });

    // ==================================================
    // Listen only after initialization completes
    // ==================================================

    // All middleware and API routes are now initialized.
    // The local server starts outside this function.
    return billing;
}

initializationPromise = startServer();

if (process.env.VERCEL) {
    // Vercel manages the HTTP server.
    // The initialization middleware waits for this promise.
    initializationPromise.catch((error) => {
        console.error("Vercel startup failed:", error);
    });
} else {
    // Local development
    initializationPromise
        .then((billing) => {
            const stopBilling = billing.start();

            const server = app.listen(port, () => {
                console.log(
                    `PizzaHub server: http://localhost:${port}`
                );
            });

            server.on("error", async (error) => {
                console.error("Server error:", error);

                stopBilling();
                await client.close();
                process.exit(1);
            });
        })
        .catch(async (error) => {
            console.error("Startup failed:", error);

            await client.close();
            process.exit(1);
        });
}

export default app;