const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const axios = require("axios");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://dental-implant-machine-5977.vercel.app",
    "https://dental-implant-machine-server-cgfs.vercel.app",

    "https://dental-implant-machine.up.railway.app",
  ],
  credentials: true,
  optionSuccessStatus: 200,
};

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
};

// const cookieOptions = {
//   httpOnly: true,
//   secure: true,
//   sameSite: "none",
// };

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

//middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wezoknx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("DentalImplant");
    const usersCollection = db.collection("users");
    const rolesCollection = db.collection("roles");
    const clinicCollection = db.collection("clinics");
    const urlReportCollection = db.collection("urlReport");
    const opportunitiesCollection = db.collection("opportunities");
    const messagesCollection = db.collection("messages");

    // opportunitiesCollection indexing
    await opportunitiesCollection.createIndex({ remoteId: 1, clinicId: 1 });

    // messagesCollection indexing
    await messagesCollection.createIndex({ remoteId: 1, clinicId: 1 });

    // verification
    const verifyToken = async (req, res, next) => {
      const token = req.cookies?.token;
      // console.log(token)

      if (!token) {
        return res
          .status(401)
          .send({ message: "token not found unauthorized access" });
      }
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          console.log(err);
          return res
            .status(401)
            .send({ message: "invalid token unauthorized access" });
        }
        req.user = decoded;
        // console.log('in verify',req.user);
        next();
      });
    };

    // verify admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.user.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isAdmin = user?.role === "Admin";
      if (!isAdmin) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // creating Token
    app.post("/jwt", async (req, res) => {
      const user = req.body;

      const token = jwt.sign(
        { email: user.email },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: "10h" },
      );

      res.cookie("token", token, cookieOptions).send({ success: true, token });
    });

    // clear cookie
    app.post("/logout", async (req, res) => {
      res.clearCookie("token", cookieOptions).send({ success: true });
    });

    // -------- user -------
    // users
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      //   const { searchText } = req.query;
      //   const regex = new RegExp(searchText, "i");

      //   const query = {
      //     $or: [{ name: regex }, { email: regex }, { role: regex }],
      //   };

      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // single user
    app.get("/user/:email", async (req, res) => {
      const { email } = req.params;
      const result = await usersCollection.findOne({ email: email });
      res.send(result);
    });

    // setter user
    app.get("/all_setter", async (req, res) => {
      const result = await usersCollection.find({ role: "Setter" }).toArray();
      res.send(result);
    });

    // User creation + update
    app.post("/user/onboard", verifyToken, verifyAdmin, async (req, res) => {
      const formData = req.body;
      const { email, name } = formData;
      const query = { email: email };

      try {
        const findUser = await usersCollection.findOne(query);

        if (!findUser) {
          const tempPassword = Math.random().toString(36).slice(-10) + "A1#";

          const user = await admin.auth().createUser({
            email,
            password: tempPassword,
            displayName: name,
          });

          const resetLink = await admin
            .auth()
            .generatePasswordResetLink(email, {
              // url: "https://dental-implant-machine-5977.vercel.app",
              url: "https://dental-implant-machine.up.railway.app",
            });

          await sendWelcomeEmail(email, name, tempPassword, resetLink);

          const db_user = await usersCollection.insertOne({
            ...formData,
            createdAt: Date.now(),
          });

          return res.json({ success: true, user, resetLink, db_user });
        } else {
          const updateDoc = {
            $set: { ...formData, updateAt: Date.now() },
          };
          const result = await usersCollection.updateOne(query, updateDoc);
          res.json({ success: true, updated: true, result });
        }
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // send mail
    const sendWelcomeEmail = async (email, name, tempPassword, resetLink) => {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        // port: 465,
        // secure: true,
        port: 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      console.log("user", process.env.SMTP_USER, "pass", process.env.SMTP_PASS);

      const mailOptions = {
        from: '"DIM Dashboard" <no-reply@dim.com>',
        to: email,
        subject: "Welcome to DIM Dashboard!",
        html: `
      <h3>Welcome to DIM Dashboard!</h3>
      <p>Hello ${name}!</p>
      <p>Your account has been successfully created.</p>
      <p>🔐 Temporary Password: <b>${tempPassword}</b></p>
      <p>⚠️ You must change your password immediately after first login.</p>
      <p>Reset your password here: <a href="${resetLink}">Change Password</a></p>
    `,
      };

      // await transporter.sendMail(mailOptions);
      try {
        await transporter.sendMail(mailOptions);
      } catch (err) {
        console.error("SMTP ERROR:", err);
        throw err;
      }
    };

    // update user
    app.patch("/update-user", verifyToken, verifyAdmin, async (req, res) => {
      const { email, selectedClients } = req.body;
      const filter = { email: email };
      const updateDoc = {
        $set: {
          selectedClients: selectedClients,
        },
      };

      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // delete user
    app.delete(
      "/delete-user/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { email } = req.body;
        const filter = { _id: new ObjectId(id) };

        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().deleteUser(user.uid);

        const result = await usersCollection.deleteOne(filter);
        res.send(result);
      },
    );

    // remove user client
    app.delete("/remove-client", verifyToken, verifyAdmin, async (req, res) => {
      const { id, user_id } = req.body;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(user_id) },
        { $pull: { selectedClients: { id: id } } },
      );
      res.send(result);
    });

    // roles
    app.get("/roles", verifyToken, verifyAdmin, async (req, res) => {
      const result = await rolesCollection.find().toArray();
      res.send(result);
    });

    app.patch("/create-role", verifyToken, verifyAdmin, async (req, res) => {
      const info = req.body;
      const { id } = req.query;

      const query =
        id && id !== "undefined"
          ? { _id: new ObjectId(id) }
          : { name: info.name };

      delete info?._id;

      const doc = { $set: { ...info, createdAt: new Date() } };
      const option = { upsert: true };

      const result = await rolesCollection.updateOne(query, doc, option);
      res.send(result);
    });

    // delete role
    app.delete(
      "/delete-role/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const result = await rolesCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      },
    );

    // get clinics
    app.get("/clinics", verifyToken, verifyAdmin, async (req, res) => {
      const result = await clinicCollection.find().toArray();
      res.send(result);
    });

    // add clinic
    // app.patch("/add-clinic", verifyToken, verifyAdmin, async (req, res) => {
    //   const info = req.body;
    //   const { id } = req.query;

    //   const query =
    //     id && id !== "undefined"
    //       ? { _id: new ObjectId(id) }
    //       : { email: info.email };

    //   delete info?._id;

    //   const doc = { $set: { ...info, createdAt: new Date() } };
    //   const option = { upsert: true };

    //   const result = await clinicCollection.updateOne(query, doc, option);
    //   res.send(result);
    // });

    // add clinic
    app.patch("/add-clinic", verifyToken, verifyAdmin, async (req, res) => {
      const info = req.body;
      const { id } = req.query;

      const query =
        id && id !== "undefined"
          ? { _id: new ObjectId(id) }
          : { email: info.email };

      delete info?._id;
      delete info?.createdAt;
      delete info?.selected;

      const doc = {
        $set: {
          ...info,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          selected: true,
          createdAt: new Date(),
        },
      };

      const option = { upsert: true };

      const result = await clinicCollection.updateOne(query, doc, option);
      res.send(result);
    });

    app.patch("/clinic/select", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { clinicId, selected } = req.body;

        if (!clinicId || typeof selected !== "boolean") {
          return res.status(400).send({
            message: "clinicId and selected(boolean) are required",
          });
        }

        const result = await clinicCollection.updateOne(
          { _id: new ObjectId(clinicId) },
          {
            $set: {
              selected,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Clinic not found" });
        }

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        res.status(500).send({
          message: "Failed to update clinic selection",
          error: error.message,
        });
      }
    });

    // delete clinic
    app.delete(
      "/delete-clinic/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };

        const result = await clinicCollection.deleteOne(filter);
        res.send(result);
      },
    );

    // get report url
    app.get("/all-url", verifyToken, verifyAdmin, async (req, res) => {
      const result = await urlReportCollection.find().toArray();
      res.send(result);
    });

    // add report url
    app.patch("/add-url", verifyToken, verifyAdmin, async (req, res) => {
      const info = req.body;
      const { id } = req.query;

      const query =
        id && id !== "undefined"
          ? { _id: new ObjectId(id) }
          : { email: info.email };

      delete info?._id;

      const doc = { $set: { ...info, createdAt: new Date() } };
      const option = { upsert: true };

      const result = await urlReportCollection.updateOne(query, doc, option);
      res.send(result);
    });

    // delete report url
    app.delete(
      "/delete-url/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };

        const result = await urlReportCollection.deleteOne(filter);
        res.send(result);
      },
    );

    // Opportunities
    async function fetchOpportunities(clinic) {
      let all = [];
      let page = 1;

      while (true) {
        const res = await axios.get(
          "https://services.leadconnectorhq.com/opportunities/search",
          {
            params: {
              location_id: clinic.location_id,
              limit: 100,
              page,
              pipeline_id: clinic.pipeline_id,
            },
            headers: {
              Authorization: `Bearer ${clinic.authorization}`,
              Version: "2021-07-28",
            },
          },
        );

        const data = res.data.opportunities || [];
        all.push(...data);

        if (data.length < 100) break;
        page++;
      }

      return all;
    }

    // Messages
    async function fetchMessages(clinic) {
      let all = [];
      let cursor = null;

      do {
        const params = {
          locationId: clinic.location_id,
          limit: 100,
        };

        // if (clinic.lastSyncAt)
        //   params.startAfter = clinic.lastSyncAt.toISOString();

        if (cursor) params.cursor = cursor;

        const res = await axios.get(
          "https://services.leadconnectorhq.com/conversations/messages/export",
          {
            params,
            headers: {
              Authorization: `Bearer ${clinic.authorization}`,
              Version: "2021-07-28",
            },
          },
        );

        all.push(...(res.data.messages || []));
        cursor = res.data.nextCursor || null;
      } while (cursor);

      return all;
    }

    // cron.schedule("0 */6 * * *", async () => {
    //   cron.schedule("*/1 * * * *", async () => {
    //   console.log("Multi-clinic sync started");

    //   const clinics = await db
    //     .collection("clinics")
    //     .find({ selected: true })
    //     .toArray();

    //   for (const clinic of clinics) {
    //     try {
    //       console.log(`Syncing ${clinic.name}`);

    //       const opportunities = await fetchOpportunities(clinic);
    //       const messages = await fetchMessages(clinic);

    //       const filteredOpportunities = opportunities.filter(o=>o.pipelineId === clinic.pipeline_id)
    //       console.log(filteredOpportunities.length);

    //       // Clear old clinic data
    //       await db.collection("opportunities").deleteMany({
    //         clinicId: new ObjectId(clinic._id),
    //       });

    //       await db.collection("messages").deleteMany({
    //         clinicId: new ObjectId(clinic._id),
    //       });

    //       // Insert new
    //       if (filteredOpportunities.length) {
    //         await db.collection("opportunities").insertMany(
    //           opportunities.map((o) => ({
    //             clinicId: clinic._id,
    //             contactId: o.contactId,
    //             pipelineId: o.pipelineId,
    //             pipelineStageId: o.pipelineStageId,
    //             createdAt: new Date(o.createdAt),
    //           })),
    //         );
    //       }

    //       if (messages.length) {
    //         await db.collection("messages").insertMany(
    //           messages.map((m) => ({
    //             clinicId: clinic._id,
    //             contactId: m.contactId,
    //             direction: m.direction,
    //             messageType: m.messageType,
    //             status: m.status,
    //             dateAdded: new Date(m.dateAdded),
    //           })),
    //         );
    //       }

    //       // Update sync time
    //       await db
    //         .collection("clinics")
    //         .updateOne(
    //           { _id: clinic._id },
    //           { $set: { lastSyncAt: new Date() } },
    //         );

    //       console.log(`Done ${clinic.name}`);
    //     } catch (err) {
    //       console.error(`Failed ${clinic.name}`, err.message);
    //     }
    //   }

    //   console.log("🏁 Multi-clinic sync finished");
    // });

    cron.schedule("0 */3 * * *", async () => {
      console.log("🔄 Multi-clinic sync started");

      const clinics = await db.collection("clinics").find().toArray();

      for (const clinic of clinics) {
        try {
          console.log(`➡️ Syncing ${clinic.name}`);

          const [opportunities, messages] = await Promise.all([
            fetchOpportunities(clinic),
            fetchMessages(clinic),
          ]);

          if (opportunities.length > 0) {
            const oppOps = opportunities.map((o) => ({
              updateOne: {
                filter: { remoteId: o.id, clinicId: clinic._id },
                update: {
                  $set: {
                    clinicId: clinic._id,
                    remoteId: o.id,
                    contactId: o.contactId,
                    pipelineId: o.pipelineId,
                    pipelineStageId: o.pipelineStageId,
                    createdAt: new Date(o.createdAt),
                    // estDateOnly: dayjs(o.createdAt)
                    //   .tz("America/New_York")
                    //   .format("YYYY-MM-DD"),
                    // createdAt: o.createdAt.split("T")[0],
                    name: o.name,
                    lastStageChangeAt: new Date(o.lastStageChangeAt),
                    clinicTimezone: clinic.timezone,
                    // status: o.status,
                    // updatedAt: new Date(o.updatedAt),
                    // dateOnly: o.createdAt.split("T")[0],
                  },
                },
                upsert: true,
              },
            }));
            await db.collection("opportunities").bulkWrite(oppOps);
          }

          if (messages.length > 0) {
            const msgOps = messages.map((m) => ({
              updateOne: {
                filter: { remoteId: m.id, clinicId: clinic._id },
                update: {
                  $set: {
                    clinicId: clinic._id,
                    contactId: m.contactId,
                    direction: m.direction,
                    messageType: m.messageType,
                    dateAdded: new Date(m.dateAdded),
                    // dateAdded: m.dateAdded.split("T")[0],
                    status: m.status,
                    remoteId: m.id,
                    clinicTimezone: clinic.timezone,
                    userId: m.userId,

                    dateLocal: dayjs(m.dateAdded)
                      .tz(clinic.timezone)
                      .format("YYYY-MM-DD"),
                    dateLocalFull: new Date(
                      dayjs(m.dateAdded)
                        .tz(clinic.timezone)
                        .format("YYYY-MM-DDTHH:mm:ss.SSS[Z]"),
                    ),

                    // conversationId: m.conversationId,
                  },
                },
                upsert: true,
              },
            }));
            await db.collection("messages").bulkWrite(msgOps);
          }

          await db
            .collection("clinics")
            .updateOne(
              { _id: clinic._id },
              { $set: { lastSyncAt: new Date() } },
            );

          console.log(
            `✅ Done ${clinic.name}: ${opportunities.length} Opps, ${messages.length} Msgs`,
          );
        } catch (err) {
          console.error(`❌ Failed ${clinic.name}:`, err.message);
        }
      }
      console.log("🏁 Multi-clinic sync finished");
    });

    // ***
    // app.get("/opportunities", verifyToken, async (req, res) => {
    //   const { from, to } = req.query;
    //   const query = {};
    //   console.log(from,to);

    //   if (from && to) {
    //     const start = new Date(from);
    //     start.setHours(0, 0, 0, 0);

    //     const end = new Date(to);
    //     end.setHours(23, 59, 59, 999);

    //     query.createdAt = {
    //       $gte: start,
    //       $lte: end,
    //     };
    //   }

    //   // if (from && to) {
    //   //   query.createdAt = {
    //   //     $gte: new Date(from),
    //   //     $lt: new Date(new Date(to).setDate(new Date(to).getDate() + 1)),
    //   //   };
    //   // }

    //   const opportunities = await opportunitiesCollection.find(query).toArray();

    //   res.send(opportunities);
    // });

    // ****

    // row
    // app.get("/opportunities", verifyToken, async (req, res) => {
    //   const { from, to } = req.query;
    //   const query = {};

    //   if (from && to) {
    //     // const start = new Date(from);
    //     // start.setHours(0, 0, 0, 0);

    //     // const end = new Date(to);
    //     // end.setHours(23, 59, 59, 999);

    //     query.createdAt = {
    //       $gte: new Date(from),
    //       $lte: new Date(to),
    //     };
    //   }
    //   // console.log(query);

    //   const opportunities = await opportunitiesCollection.find(query).toArray();
    //   res.send(opportunities);
    // });

    dayjs.extend(utc);
    dayjs.extend(timezone);

    // single clinic
    // app.get("/opportunities", async (req, res) => {
    //   const { from, to, clinicId } = req.query;

    //   // console.log(clinicId);
    //   const clinic = await clinicCollection.findOne({
    //     _id: new ObjectId(clinicId),
    //   });
    //   // console.log(clinic);

    //   const tz = clinic?.timezone || "UTC";
    //   // console.log(tz);

    //   const start = dayjs.tz(from, tz).startOf("day").toDate();
    //   const end = dayjs.tz(to, tz).endOf("day").toDate();
    //   // console.log(start, end);

    //   const opportunities = await opportunitiesCollection
    //     .find({
    //       clinicId: new ObjectId("696dfd4719d8c1c8737994b2"),
    //       createdAt: { $gte: start, $lte: end },
    //     })
    //     .toArray();

    //   // console.log(opportunities.length);

    //   res.send(opportunities);
    // });

    // multiple clinics
    // app.get("/opportunities", async (req, res) => {
    //   const { from, to, clinicIds } = req.query;
    //   // if (!clinicIds) return res.send([]);

    //   const ids = JSON.parse(clinicIds);
    //   // if (ids.length === 0) return res.send([]);

    //   const objectIds = ids.map((id) => new ObjectId(id)) || [];
    //   // if (objectIds.length <= 1) return [];
    //   // console.log(objectIds);

    //   const clinics = await clinicCollection
    //     .find({ _id: { $in: objectIds } })
    //     .toArray();
    //   // if (clinics.length === 0) return res.send([]);

    //   const orConditions = clinics.map((clinic) => {
    //     const tz = clinic.timezone || "UTC";

    //     const start = dayjs.tz(from, tz).startOf("day").toDate();
    //     const end = dayjs.tz(to, tz).endOf("day").toDate();

    //     return {
    //       clinicId: new ObjectId(clinic._id),
    //       createdAt: { $gte: start, $lte: end },
    //     };
    //   });

    //   const opportunities = await opportunitiesCollection
    //     .find({ $or: orConditions })
    //     .toArray();

    //   res.send(opportunities);
    // });

    // multiple clinics with empty clinicIds handle
    app.get("/opportunities", verifyToken, async (req, res) => {
      const { from, to, clinicIds } = req.query;

      const ids = clinicIds ? JSON.parse(clinicIds) : [];
      if (ids.length === 0) return res.send([]);

      const objectIds = ids.map((id) => new ObjectId(id));

      const clinics = await clinicCollection
        .find({ _id: { $in: objectIds } })
        .toArray();

      if (clinics.length === 0) return res.send([]);

      const orConditions = clinics.map((clinic) => {
        const tz = clinic.timezone || "UTC";

        const start = dayjs.tz(from, tz).startOf("day").toDate();
        const end = dayjs.tz(to, tz).endOf("day").toDate();

        return {
          clinicId: new ObjectId(clinic._id),
          createdAt: { $gte: start, $lte: end },
        };
      });

      if (orConditions.length === 0) return res.send([]);

      const opportunities = await opportunitiesCollection
        .find({ $or: orConditions })
        .toArray();

      res.send(opportunities);
    });

    // single clinic
    // app.get("/messages", async (req, res) => {
    //   const { from, to, clinicId } = req.query;

    //   // console.log(clinicId);
    //   const clinic = await clinicCollection.findOne({
    //     _id: new ObjectId(clinicId),
    //   });
    //   // console.log(clinic);

    //   const tz = clinic?.timezone || "UTC";
    //   // console.log(tz);

    //   const start = dayjs.tz(from, tz).startOf("day").toDate();
    //   const end = dayjs.tz(to, tz).endOf("day").toDate();
    //   // console.log(start, end);

    //   const messages = await messagesCollection
    //     .find({
    //       clinicId: new ObjectId("696dfd4719d8c1c8737994b2"),
    //       dateAdded: { $gte: start, $lte: end },
    //     })
    //     .toArray();

    //   // console.log(messages.length);

    //   res.send(messages);
    // });

    // multiple clinics v1
    // app.get("/messages", async (req, res) => {
    //   const { from, to, clinicIds } = req.query;
    //   // if (!clinicIds) return res.send([]);

    //   const ids = JSON.parse(clinicIds);
    //   // if (ids.length === 0) return res.send([]);

    //   const objectIds = ids.map((id) => new ObjectId(id));

    //   const clinics = await clinicCollection
    //     .find({ _id: { $in: objectIds } })
    //     .toArray();
    //   // if (clinics.length === 0) return res.send([]);

    //   const orConditions = clinics.map((clinic) => {
    //     const tz = clinic.timezone || "UTC";

    //     const start = dayjs.tz(from, tz).startOf("day").toDate();
    //     const end = dayjs.tz(to, tz).endOf("day").toDate();

    //     return {
    //       clinicId: clinic._id,
    //       dateAdded: { $gte: start, $lte: end },
    //     };
    //   });

    //   const messages = await messagesCollection
    //     .find({ $or: orConditions })
    //     .toArray();
    //     console.log(messages.length);

    //   res.send(messages);
    // });

    // multiple clinics v2
    // app.get("/messages", async (req, res) => {
    //   const { from, to, clinicIds } = req.query;

    //   const ids = clinicIds ? JSON.parse(clinicIds) : [];
    //   if (ids.length === 0) return res.send([]);

    //   const objectIds = ids.map((id) => new ObjectId(id));

    //   const clinics = await clinicCollection
    //     .find({ _id: { $in: objectIds } })
    //     .toArray();

    //   if (clinics.length === 0) return res.send([]);

    //   const orConditions = clinics.map((clinic) => {
    //     const tz = clinic.timezone || "UTC";

    //     const start = dayjs.tz(from, tz).startOf("day").toDate();
    //     const end = dayjs.tz(to, tz).endOf("day").toDate();

    //     return {
    //       clinicId: new ObjectId(clinic._id),
    //       dateAdded: { $gte: start, $lte: end },
    //     };
    //   });

    //   if (orConditions.length === 0) return res.send([]);

    //   const messages = await messagesCollection
    //     .find({ $or: orConditions })
    //     .toArray();

    //   res.send(messages);
    // });

    // alada time zone function

    // 81.82% 1-10 dec
    // app.get("/messages", async (req, res) => {
    //   try {
    //     const { from, to, clinicIds } = req.query;

    //     const ids = clinicIds ? JSON.parse(clinicIds) : [];
    //     if (!ids.length) return res.send([]);

    //     const objectIds = ids.map((id) => new ObjectId(id));

    //     const clinics = await clinicCollection
    //       .find({ _id: { $in: objectIds } })
    //       .toArray();

    //     if (!clinics.length) return res.send([]);

    //     const orConditions = clinics.map((clinic) => {
    //       const tz = clinic.timezone || "UTC";

    //       // convert incoming UTC → clinic timezone → clamp day → back to UTC
    //       const start = dayjs(from).tz(tz).startOf("day").utc().toDate();

    //       const end = dayjs(to).tz(tz).endOf("day").utc().toDate();

    //       return {
    //         clinicId: clinic._id,
    //         dateAdded: { $gte: start, $lte: end },
    //       };
    //     });

    //     const messages = await messagesCollection
    //       .find({ $or: orConditions })
    //       .toArray();

    //     res.send(messages);
    //   } catch (err) {
    //     console.error("Messages fetch error:", err);
    //     res.status(500).send({ error: "Failed to fetch messages" });
    //   }
    // });

    app.get("/messages", verifyToken, async (req, res) => {
      try {
        const { from, to, clinicIds } = req.query;
        console.log(from, to);

        const ids = clinicIds ? JSON.parse(clinicIds) : [];
        if (ids.length === 0) return res.send([]);

        const objectIds = ids.map((id) => new ObjectId(id));

        const clinics = await clinicCollection
          .find({ _id: { $in: objectIds } })
          .toArray();

        if (clinics.length === 0) return res.send([]);

        const orConditions = clinics.map((clinic) => {
          // const tz = clinic.timezone || "UTC";
          // const tz = "Asia/Dhaka" || "UTC";
          const tz = "America/Denver" || "UTC";

          const start = dayjs.tz(from, tz).startOf("day").toDate();
          const end = dayjs.tz(to, tz).endOf("day").toDate();
          console.log(start, end);

          return {
            clinicId: clinic._id,
            dateAdded: { $gte: start, $lte: end },
          };
        });

        const messages = await messagesCollection
          .find({ $or: orConditions })
          .toArray();

        res.send(messages);
      } catch (err) {
        console.error("Messages fetch error:", err);
        res.status(500).send({ error: "Failed to fetch messages" });
      }
    });

    // *****
    // dayjs.extend(utc);
    // dayjs.extend(timezone);
    // app.get("/opportunities", verifyToken, async (req, res) => {
    //   const { from, to } = req.query;

    //   if (from && to) {
    //     const start = dayjs
    //       .tz(from, "America/New_York")
    //       .startOf("day")
    //       .toDate();

    //     const end = dayjs.tz(to, "America/New_York").endOf("day").toDate();

    //     const query = {
    //       createdAt: { $gte: start, $lte: end },
    //     };
    //     console.log(query);

    //     const opportunities = await opportunitiesCollection
    //       .find(query)
    //       .toArray();
    //     res.send(opportunities);
    //   }
    // });

    // app.get("/messages", verifyToken, async (req, res) => {
    //   const { from, to } = req.query;
    //   const query = {};

    //   if (from && to) {
    //     // const start = new Date(from);
    //     // start.setHours(0, 0, 0, 0);

    //     // const end = new Date(to);
    //     // end.setHours(23, 59, 59, 999);

    //     query.dateAdded = {
    //       $gte: new Date(from),
    //       $lte: new Date(to),
    //     };
    //   }
    //   // console.log(query);

    //   // console.log(query);
    //   const messages = await messagesCollection.find(query).toArray();
    //   res.send(messages);
    // });

    // ---------- performance optimize -----------
    // const pLimit = require("p-limit");
    // const CONCURRENCY = 3;
    // const limit = pLimit(CONCURRENCY);
    // cron.schedule("0 */3 * * *", async () => {
    //   console.log("🔄 Multi-clinic sync started");

    //   const clinics = await db
    //     .collection("clinics")
    //     .find({ selected: true })
    //     .toArray();

    //   const syncClinic = async (clinic) => {
    //     try {
    //       console.log(`➡️ Syncing ${clinic.name}`);

    //       const [opportunities, messages] = await Promise.all([
    //         fetchOpportunities(clinic),
    //         fetchMessages(clinic),
    //       ]);

    //       if (opportunities.length > 0) {
    //         const oppOps = opportunities.map((o) => ({
    //           updateOne: {
    //             filter: { remoteId: o.id, clinicId: clinic._id },
    //             update: {
    //               $set: {
    //                 clinicId: clinic._id,
    //                 remoteId: o.id,
    //                 contactId: o.contactId,
    //                 pipelineId: o.pipelineId,
    //                 pipelineStageId: o.pipelineStageId,
    //                 createdAt: new Date(o.createdAt),
    //               },
    //             },
    //             upsert: true,
    //           },
    //         }));
    //         await db.collection("opportunities").bulkWrite(oppOps);
    //       }

    //       if (messages.length > 0) {
    //         const msgOps = messages.map((m) => ({
    //           updateOne: {
    //             filter: { remoteId: m.id, clinicId: clinic._id },
    //             update: {
    //               $set: {
    //                 clinicId: clinic._id,
    //                 contactId: m.contactId,
    //                 direction: m.direction,
    //                 messageType: m.messageType,
    //                 dateAdded: new Date(m.dateAdded),
    //                 status: m.status,
    //                 remoteId: m.id,
    //               },
    //             },
    //             upsert: true,
    //           },
    //         }));
    //         await db.collection("messages").bulkWrite(msgOps);
    //       }

    //       await db.collection("clinics").updateOne(
    //         { _id: clinic._id },
    //         { $set: { lastSyncAt: new Date() } }
    //       );

    //       console.log(
    //         `✅ Done ${clinic.name}: ${opportunities.length} Opps, ${messages.length} Msgs`
    //       );
    //     } catch (err) {
    //       console.error(`❌ Failed ${clinic.name}:`, err.message);
    //     }
    //   };

    //   await Promise.all(
    //     clinics.map((clinic) => limit(() => syncClinic(clinic)))
    //   );

    //   console.log("🏁 Multi-clinic sync finished");
    // });

    app.post("/kpi-report", async (req, res) => {
      try {
        const { from, to, clinicIds = [] } = req.body;

        const dateFrom = from ? new Date(from) : new Date("2000-01-01");
        const dateTo = to ? new Date(to) : new Date();

        // Convert clinicIds to ObjectId
        const clinicObjectIds = clinicIds.map((id) => new ObjectId(id));

        const clinics = await clinicCollection
          .find({
            _id: { $in: clinicObjectIds },
            selected: true,
          })
          .toArray();

        const result = await generateKPIReport({
          dateFrom,
          dateTo,
          clinics,
        });

        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "KPI report failed" });
      }
    });

    // KPI Report Service (Core Logic)
    async function generateKPIReport({ dateFrom, dateTo, clinics }) {
      const clinicIds = clinics.map((c) => c._id);

      const conversationStages = new Set(
        clinics.flatMap((c) => c.conversion_pipelines.map((p) => p.id)),
      );
      const bookingStages = new Set(
        clinics.flatMap((c) => c.booking_pipelines.map((p) => p.id)),
      );
      const showingStages = new Set(
        clinics.flatMap((c) => c.showing_pipelines.map((p) => p.id)),
      );
      const closeStages = new Set(
        clinics.flatMap((c) => c.close_pipelines.map((p) => p.id)),
      );

      /* ---------- Leads ---------- */
      const leads = await opportunitiesCollection
        .aggregate([
          {
            $match: {
              clinicId: { $in: clinicIds },
              createdAt: { $gte: dateFrom, $lte: dateTo },
            },
          },
        ])
        .toArray();

      /* ---------- Messages ---------- */
      const messages = await messagesCollection
        .aggregate([
          {
            $match: {
              clinicId: { $in: clinicIds },
              dateAdded: { $gte: dateFrom, $lte: dateTo },
            },
          },
        ])
        .toArray();

      /* ---------- KPI Calculations ---------- */
      const inboundCalls = messages.filter(
        (m) => m.direction === "inbound" && m.messageType === "TYPE_CALL",
      );

      const answeredCalls = inboundCalls.filter(
        (m) => m.status === "completed",
      );

      const inboundCallRate = inboundCalls.length
        ? (answeredCalls.length / inboundCalls.length) * 100
        : 0;

      const countByStage = (set) =>
        leads.filter((l) => set.has(l.pipelineStageId)).length;

      /* ---------- Monthly Chart ---------- */
      const monthlyChart = buildMonthlyChart({
        leads,
        conversationStages,
        bookingStages,
        showingStages,
        closeStages,
        dateTo,
      });

      /* ---------- Last 30 Days ---------- */
      const last30Days = buildLast30Days({
        leads,
        messages,
        conversationStages,
        bookingStages,
        showingStages,
        closeStages,
        dateTo,
      });

      return {
        summary: {
          newLeads: leads.length,
          inboundCallRate: inboundCallRate.toFixed(2),
          conversations: countByStage(conversationStages),
          booking: countByStage(bookingStages),
          showing: countByStage(showingStages),
          close: countByStage(closeStages),
        },
        monthlyChart,
        last30Days,
      };
    }

    // Monthly Chart Builder
    function buildMonthlyChart({
      leads,
      conversationStages,
      bookingStages,
      showingStages,
      closeStages,
      dateTo,
    }) {
      const months = [];

      for (let i = 11; i >= 0; i--) {
        const d = new Date(dateTo);
        d.setMonth(d.getMonth() - i);

        const key = `${d.getFullYear()}-${d.getMonth()}`;
        months.push({
          key,
          month: d.toLocaleString("en-US", {
            month: "short",
            year: "numeric",
          }),
          totalLead: 0,
          conversion: 0,
          booking: 0,
          showing: 0,
          close: 0,
        });
      }

      const map = Object.fromEntries(months.map((m) => [m.key, m]));

      leads.forEach((l) => {
        const d = new Date(l.createdAt);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        if (!map[key]) return;

        map[key].totalLead++;
        if (conversationStages.has(l.pipelineStageId)) map[key].conversion++;
        if (bookingStages.has(l.pipelineStageId)) map[key].booking++;
        if (showingStages.has(l.pipelineStageId)) map[key].showing++;
        if (closeStages.has(l.pipelineStageId)) map[key].close++;
      });

      return Object.values(map);
    }

    // Last 30 Days KPI Builder
    function buildLast30Days({
      leads,
      messages,
      conversationStages,
      bookingStages,
      showingStages,
      closeStages,
      dateTo,
    }) {
      const rows = [];

      for (let i = 0; i < 30; i++) {
        const day = new Date(dateTo);
        day.setDate(day.getDate() - i);

        const start = new Date(day.setHours(0, 0, 0, 0));
        const end = new Date(day.setHours(23, 59, 59, 999));

        const dailyLeads = leads.filter(
          (l) => new Date(l.createdAt) >= start && new Date(l.createdAt) <= end,
        );

        const dailyMessages = messages.filter(
          (m) => new Date(m.dateAdded) >= start && new Date(m.dateAdded) <= end,
        );

        const inbound = dailyMessages.filter(
          (m) => m.direction === "inbound" && m.messageType === "TYPE_CALL",
        );

        const answered = inbound.filter((m) => m.status === "completed");

        rows.push({
          date: start.toISOString().slice(0, 10),
          totalLead: dailyLeads.length,
          inboundCallRate: inbound.length
            ? ((answered.length / inbound.length) * 100).toFixed(2)
            : "0.00",
          conversion: dailyLeads.filter((l) =>
            conversationStages.has(l.pipelineStageId),
          ).length,
          booking: dailyLeads.filter((l) =>
            bookingStages.has(l.pipelineStageId),
          ).length,
          showing: dailyLeads.filter((l) =>
            showingStages.has(l.pipelineStageId),
          ).length,
          close: dailyLeads.filter((l) => closeStages.has(l.pipelineStageId))
            .length,
        });
      }

      return rows;
    }

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Alive Dental implant machine website serve");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
