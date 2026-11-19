import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";

import { createAuthMiddleware, APIError } from "better-auth/api";

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

    const menuItemsCollection = db.collection("menuItems");

    // --------------------------------------------------
    // Development demo data
    // Run manually with: node index.js --seed
    // --------------------------------------------------

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
            const items = await menuItemsCollection
                .find(
                    {
                        status: "approved",
                        isAvailable: true,
                    },
                    {
                        projection: {
                            itemName: 1,
                            category: 1,
                            description: 1,
                            price: 1,
                            location: 1,
                            images: 1,
                            vendorId: 1,
                            vendorName: 1,
                            createdAt: 1,
                        },
                    }
                )
                .sort({ createdAt: -1, _id: -1 })
                .limit(6)
                .toArray();

            res.json({
                success: true,
                data: items,
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
            const allowedCategories = [
                "classic-pizzas",
                "vegetarian-pizzas",
                "meat-lovers",
                "specialty-gourmet-pizzas",
                "sides-appetizers",
                "beverages-desserts",
            ];

            // Reject objects/arrays and overly long query values.
            function readQuery(name, fallback = "") {
                const value = req.query[name];

                if (value === undefined) return fallback;

                if (typeof value !== "string" || value.length > 100) {
                    throw new Error("INVALID_QUERY");
                }

                return value.trim();
            }

            const search = readQuery("search");
            const category = readQuery("category");
            const location = readQuery("location");
            const sort = readQuery("sort", "newest");
            const pageValue = readQuery("page", "1");

            if (
                (category && !allowedCategories.includes(category)) ||
                !["newest", "price-asc", "price-desc"].includes(sort) ||
                !/^[1-9]\d*$/.test(pageValue)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid menu filters.",
                });
            }

            const page = Number(pageValue);
            const limit = 12;

            if (!Number.isSafeInteger(page) || page > 10000) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid page number.",
                });
            }

            // Treat search input as literal text, not a regex expression.
            const escapeRegex = (value) =>
                value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            const filter = {
                status: "approved",
                isAvailable: true,
            };

            if (search) {
                filter.itemName = {
                    $regex: escapeRegex(search),
                    $options: "i",
                };
            }

            if (category) {
                filter.category = category;
            }

            if (location) {
                filter.location = {
                    $regex: escapeRegex(location),
                    $options: "i",
                };
            }

            const sorting =
                sort === "price-asc"
                    ? { price: 1, _id: 1 }
                    : sort === "price-desc"
                        ? { price: -1, _id: -1 }
                        : { createdAt: -1, _id: -1 };

            const [items, total] = await Promise.all([
                menuItemsCollection
                    .find(filter, {
                        projection: {
                            itemName: 1,
                            category: 1,
                            description: 1,
                            price: 1,
                            location: 1,
                            images: 1,
                            vendorId: 1,
                            vendorName: 1,
                        },
                    })
                    .sort(sorting)
                    .skip((page - 1) * limit)
                    .limit(limit)
                    .toArray(),

                menuItemsCollection.countDocuments(filter),
            ]);

            res.json({
                success: true,
                data: items,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            if (error.message === "INVALID_QUERY") {
                return res.status(400).json({
                    success: false,
                    message: "Invalid menu filters.",
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