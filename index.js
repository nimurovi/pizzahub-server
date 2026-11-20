import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";

import { createAuthMiddleware, APIError } from "better-auth/api";
import multer from "multer";
import sharp from "sharp";


// --------------------------------------------------
// 1. Environment configuration
// --------------------------------------------------

const port = Number(process.env.PORT || 5000);
const clientUrl = process.env.CLIENT_URL;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.DB_NAME || "pizzahub";

if (!mongoUri || !clientUrl) {
    console.error("Missing MONGODB_URI or CLIENT_URL in .env");
    process.exit(1);
}

// --------------------------------------------------
// 2. Express and MongoDB setup
// --------------------------------------------------

const app = express();

app.disable("x-powered-by");

app.use(
    cors({
        origin: clientUrl,
        credentials: true,
    })
);

// Later, register Better Auth and the Stripe raw-body
// webhook handler BEFORE this JSON parser.


const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
});

// --------------------------------------------------
// 3. Connect and register routes
// --------------------------------------------------

async function startServer() {
    await client.connect();

    const db = client.db(databaseName);
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

    const auth = betterAuth({
        appName: "PizzaHub",

        baseURL: process.env.BETTER_AUTH_URL,
        secret: process.env.BETTER_AUTH_SECRET,

        trustedOrigins: [clientUrl],

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
                // Only customer and vendor accounts can register publicly.
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

                // Prevent users from changing their role through other auth endpoints.
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
                    ctx.path === "/sign-up/email" || ctx.path === "/set-password"
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

    // Authentication routes must come before express.json().
    app.all(/^\/api\/auth(?:\/.*)?$/, toNodeHandler(auth));

    // JSON parsing for your existing menu routes.
    app.use(express.json({ limit: "100kb" }));

    const usersCollection = db.collection("users");

    // Verify the session and read the latest account from MongoDB.
    async function requireAccount(req, res, next) {
        try {
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
            });

            if (!session?.user) {
                return res.status(401).json({
                    success: false,
                    message: "Please sign in first.",
                });
            }

            const userId = session.user.id;

            const databaseId = ObjectId.isValid(userId)
                ? new ObjectId(userId)
                : userId;

            const user = await usersCollection.findOne({
                _id: databaseId,
            });

            if (!user) {
                return res.status(401).json({
                    success: false,
                    message: "Account not found. Please sign in again.",
                });
            }

            if (user.isBlocked === true) {
                return res.status(403).json({
                    success: false,
                    message: "Your account is blocked.",
                });
            }

            req.account = user;
            next();
        } catch (error) {
            next(error);
        }
    }

    // Read the current role and whether selection is still required.
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

    // Save a role once. Never accept a user ID from the browser.
    app.post("/api/onboarding/role", requireAccount, async (req, res, next) => {
        try {
            // Protect this cookie-authenticated write against other origins.
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

            const role = req.body?.role;

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
    });

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

            const name = typeof body.name === "string" ? body.name.trim() : "";

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

    // Accept one profile image, up to 2 MB.
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
        // Protect this cookie-authenticated upload from cross-site requests.
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

            // Validate the actual image contents, not just its file extension.
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
                // The account ID comes from the verified session.
                // Never accept a user ID or email from the upload form.
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

    const menuItemsCollection = db.collection("menuItems");

    // --------------------------------------------------
    // Development demo data
    // Run manually with: node index.js --seed
    // --------------------------------------------------

    const ordersCollection = db.collection("orders");

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



    function activeVendorStages() {
        return [
            {
                $lookup: {
                    from: "users",
                    let: {
                        vendorStringId: {
                            $convert: {
                                input: "$vendorId",
                                to: "string",
                                onError: null,
                                onNull: null,
                            },
                        },
                        vendorObjectId: {
                            $convert: {
                                input: "$vendorId",
                                to: "objectId",
                                onError: null,
                                onNull: null,
                            },
                        },
                    },
                    pipeline: [
                        {
                            $match: {
                                role: "vendor",
                                isBlocked: { $ne: true },
                                roleSelectionPending: { $ne: true },
                                $expr: {
                                    $or: [
                                        { $eq: ["$_id", "$$vendorStringId"] },
                                        { $eq: ["$_id", "$$vendorObjectId"] },
                                    ],
                                },
                            },
                        },
                        {
                            $project: {
                                name: 1,
                                image: 1,
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: "vendor",
                },
            },

            // Removes items whose vendor was not found or is inactive.
            { $unwind: "$vendor" },

            {
                $set: {
                    vendorId: { $toString: "$vendor._id" },
                    vendorName: "$vendor.name",
                    vendorImage: { $ifNull: ["$vendor.image", null] },
                },
            },
        ];
    }

    const publicMenuProjection = {
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
        createdAt: 1,
    };


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


    await menuItemsCollection.createIndex({
        status: 1,
        isAvailable: 1,
        createdAt: -1,
        _id: -1,
    });

    // Server health
    app.get("/", (req, res) => {
        res.json({
            success: true,
            message: "PizzaHub server is running.",
        });
    });

    // Public featured menu endpoint
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
                    { $sort: { createdAt: -1, _id: -1 } },
                    { $limit: 6 },
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

    // Private: read one approved, available menu item.
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

            const item = await menuItemsCollection.findOne(
                {
                    _id: new ObjectId(id),
                    status: "approved",
                    isAvailable: true,
                },
                {
                    projection: {
                        itemName: 1,
                        description: 1,
                        category: 1,
                        price: 1,
                        location: 1,
                        images: 1,
                        vendorId: 1,
                    },
                }
            );

            if (!item) {
                return res.status(404).json({
                    success: false,
                    message: "This menu item is unavailable or does not exist.",
                });
            }

            const vendorId = String(item.vendorId ?? "");

            if (!vendorId) {
                return res.status(404).json({
                    success: false,
                    message: "This item's vendor is unavailable.",
                });
            }

            // Support existing string IDs and MongoDB ObjectIds.
            const possibleIds = [vendorId];

            if (/^[a-fA-F0-9]{24}$/.test(vendorId)) {
                possibleIds.push(new ObjectId(vendorId));
            }

            const vendor = await usersCollection.findOne(
                {
                    _id: { $in: possibleIds },
                    role: "vendor",
                    isBlocked: { $ne: true },
                    roleSelectionPending: { $ne: true },
                },
                {
                    projection: {
                        name: 1,
                        image: 1,
                    },
                }
            );

            if (!vendor) {
                return res.status(404).json({
                    success: false,
                    message: "This item's vendor is unavailable.",
                });
            }

            return res.status(200).json({
                success: true,
                data: {
                    ...item,
                    vendorId: String(vendor._id),
                    vendorName: vendor.name,
                    vendorImage: vendor.image ?? null,
                },
            });
        } catch (error) {
            next(error);
        }
    });

    // --------------------------------------------------
    // Public menu: search, filters, sorting, pagination
    // --------------------------------------------------

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

                    // Check the vendor before pagination and counting.
                    ...activeVendorStages(),

                    {
                        $facet: {
                            items: [
                                { $sort: sortOptions },
                                { $skip: (page - 1) * limit },
                                { $limit: limit },
                                { $project: publicMenuProjection },
                            ],
                            totalCount: [
                                { $count: "total" },
                            ],
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

    app.post("/api/orders", requireAccount, async (req, res, next) => {
        try {
            res.set("Cache-Control", "no-store");

            // Protect requests that authenticate using session cookies.
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

            if (
                !body ||
                typeof body !== "object" ||
                Array.isArray(body)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid order data.",
                });
            }

            const allowedFields = ["itemId", "orderDate", "quantity"];

            if (Object.keys(body).some((key) => !allowedFields.includes(key))) {
                return res.status(400).json({
                    success: false,
                    message: "The order contains unsupported fields.",
                });
            }

            const { itemId, orderDate } = body;
            const quantity = body.quantity ?? 1;

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

            // Use Bangladesh's date consistently, regardless of server location.
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

            // Check current item availability and the vendor's account.
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

            if (item.vendorId === customerId) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot order your own menu item.",
                });
            }

            // Calculate prices on the backend, never from browser-supplied totals.
            const unitPriceMinor = Math.round(item.price * 100);

            if (
                typeof item.price !== "number" ||
                !Number.isFinite(item.price) ||
                item.price <= 0 ||
                !Number.isSafeInteger(unitPriceMinor) ||
                !Number.isSafeInteger(unitPriceMinor * quantity)
            ) {
                return res.status(409).json({
                    success: false,
                    message: "This item's price needs to be corrected before ordering.",
                });
            }

            const totalPriceMinor = unitPriceMinor * quantity;
            const now = new Date();

            const order = {
                customerId,
                customerName: account.name,
                itemId: String(item._id),
                itemName: item.itemName,
                itemImage: Array.isArray(item.images)
                    ? item.images[0] ?? null
                    : null,
                vendorId: item.vendorId,
                vendorName: item.vendorName,
                location: item.location,
                orderDate,
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

    // --------------------------------------------------
    // 4. Unknown routes
    // --------------------------------------------------

    app.use((req, res) => {
        res.status(404).json({
            success: false,
            message: "API route not found.",
        });
    });

    // --------------------------------------------------
    // 5. Error handler
    // --------------------------------------------------

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

    // --------------------------------------------------
    // 6. Start listening
    // --------------------------------------------------

    const server = app.listen(port, () => {
        console.log(`PizzaHub server: http://localhost:${port}`);
    });

    server.on("error", async (error) => {
        console.error("Server could not start:", error.code);
        await client.close();
        process.exit(1);
    });
}

startServer().catch(async (error) => {
    console.error("Startup failed:", error.name);
    console.error("Details:", error.message);

    await client.close();
    process.exit(1);
});