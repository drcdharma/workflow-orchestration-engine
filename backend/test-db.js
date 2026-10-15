require("dotenv").config();

const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const { MongoClient } = require("mongodb");
async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is missing from .env");
    }
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db(
            process.env.DB_NAME || "workflow_orchestration"
        );
        await db.command({ ping: 1 });
        console.log("MongoDB connected successfully!");
        console.log("Database:", db.databaseName);
    } finally {
        await client.close();
    }
}
main().catch((error) => {
    console.error("MongoDB connection failed:", error.message);
    process.exitCode = 1;
});