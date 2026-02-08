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
dayjs.extend(utc);
dayjs.extend(timezone);

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
    const calendarEventsCollection = db.collection("calendarEvents");

    // // opportunitiesCollection indexing
    // await opportunitiesCollection.createIndex({ remoteId: 1, clinicId: 1 });

    // // messagesCollection indexing
    // await messagesCollection.createIndex({ remoteId: 1, clinicId: 1 });

    await opportunitiesCollection.createIndex(
      { clinicId: 1, createdAt: 1 },
      { name: "clinic_createdAt_idx" },
    );

    await opportunitiesCollection.createIndex(
      { clinicId: 1, lastStageChangeAt: 1 },
      { name: "clinic_lastStageChangeAt_idx" },
    );

    await messagesCollection.createIndex(
      { clinicId: 1, dateAdded: 1 },
      { name: "clinic_dateAdded_idx" },
    );

    await messagesCollection.createIndex(
      { contactId: 1, dateAdded: 1 },
      { name: "contact_dateAdded_idx" },
    );

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

    const verifyAutomation = (req, res, next) => {
      const key = req.headers.authorization;

      if (key !== process.env.AUTOMATION_KEY) {
        return res.status(403).send({ message: "Forbidden" });
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
        port: 465,
        secure: true,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

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

    // CalendarEvents
    async function fetchCalendarEvents(clinic, calendarId) {
      const ONE_HOUR = 60 * 60 * 1000;

      const endTime = Date.now();
      const startTime = clinic.lastSyncAt
        ? new Date(clinic.lastSyncAt).getTime() - ONE_HOUR
        : endTime - 24 * 60 * 60 * 1000;

      const res = await axios.get(
        "https://services.leadconnectorhq.com/calendars/events",
        {
          params: {
            locationId: clinic.location_id,
            calendarId,
            startTime: 1577836800000,
            endTime,
          },
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${clinic.authorization}`,
            Version: "2021-04-15",
          },
        },
      );

      return res.data.events || [];
    }

    function buildMessageMap(messages) {
      const map = new Map();

      for (const m of messages) {
        if (!m.contactId || !m.dateAdded) continue;

        if (!map.has(m.contactId)) {
          map.set(m.contactId, []);
        }

        map.get(m.contactId).push(m);
      }

      // sort once per contact
      for (const msgs of map.values()) {
        msgs.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
      }

      return map;
    }

    function filterLeadsByFirstResponseTimeInOneMInute(leads, messages) {
      let count = 0;
      const oppOps = [];

      for (const lead of leads) {
        const leadCreatedAt = new Date(lead.createdAt);
        const contactId = lead.contactId;

        const validMessages = messages.filter((msg) => {
          if (msg.contactId !== contactId) return false;
          if (!msg.dateAdded) return false;
          if (new Date(msg.dateAdded) < leadCreatedAt) return false;

          if (msg.direction !== "outbound") return false;
          if (msg.status !== "completed") return false;
          if (msg.messageType !== "TYPE_CALL") return false;
          return true;
        });

        if (!validMessages.length) continue;

        const firstMessage = validMessages.reduce((earliest, current) =>
          new Date(current.dateAdded) < new Date(earliest.dateAdded)
            ? current
            : earliest,
        );

        const responseMinutes =
          (new Date(firstMessage.dateAdded) - leadCreatedAt) / (1000 * 60);

        if (responseMinutes >= 1) {
          count++;
          oppOps.push(firstMessage);
        }
      }

      return oppOps;
    }

    function filterLeadsByFirstResponseTimeInOneMinuteOptimized(leads, messageMap) {
  const oppOps = [];

  for (const lead of leads) {
    const msgs = messageMap.get(lead.contactId);
    if (!msgs?.length) continue;

    const leadCreatedAt = new Date(lead.createdAt);

    const first = msgs.find(
      (m) =>
        new Date(m.dateAdded) >= leadCreatedAt &&
        m.direction === "outbound" &&
        m.status === "completed" &&
        m.messageType === "TYPE_CALL"
    );

    if (!first) continue;

    const responseMinutes = (new Date(first.dateAdded) - leadCreatedAt) / (1000 * 60);

    if (responseMinutes >= 1) {
      oppOps.push(first);
    }
  }

  return oppOps;
}


    function countLeadsByFirstResponseTimeRangeOptimized(
      leads,
      messageMap,
      minMinutes,
      maxMinutes = null,
      messageType = null,
      status = null,
    ) {
      let count = 0;

      for (const lead of leads) {
        const msgs = messageMap.get(lead.contactId);
        if (!msgs?.length) continue;

        const leadCreatedAt = new Date(lead.createdAt);

        const first = msgs.find(
          (m) =>
            new Date(m.dateAdded) >= leadCreatedAt &&
            m.direction === "outbound" &&
            (!messageType || m.messageType === messageType) &&
            (!status || m.status === status),
        );

        if (!first) continue;

        const responseMinutes =
          (new Date(first.dateAdded) - leadCreatedAt) / (1000 * 60);

        if (
          responseMinutes >= minMinutes &&
          (maxMinutes === null || responseMinutes <= maxMinutes)
        ) {
          count++;
        }
      }

      return count;
    }

    function countLeadsByFirstResponseTimeRange(
      leads,
      messages,
      minMinutes,
      maxMinutes,
      messageType,
      status,
    ) {
      let count = 0;

      for (const lead of leads) {
        const leadCreatedAt = new Date(lead.createdAt);
        const contactId = lead.contactId;

        const validMessages = messages.filter((msg) => {
          if (msg.contactId !== contactId) return false;
          if (!msg.dateAdded) return false;
          if (new Date(msg.dateAdded) < leadCreatedAt) return false;

          if (messageType && msg.messageType !== messageType) return false;
          if (status && msg.status !== status) return false;
          if (msg.direction !== "outbound") return false;
          return true;
        });

        if (!validMessages.length) continue;

        const firstMessage = validMessages.reduce((earliest, current) =>
          new Date(current.dateAdded) < new Date(earliest.dateAdded)
            ? current
            : earliest,
        );

        const responseMinutes =
          (new Date(firstMessage.dateAdded) - leadCreatedAt) / (1000 * 60);

        // Range check
        if (
          responseMinutes >= minMinutes &&
          (maxMinutes === null || responseMinutes <= maxMinutes)
        ) {
          count++;
        }
      }

      return count;
    }

    function calculateAvgFirstResponseTimeOptimized(
      leads,
      messageMap,
      messageType,
    ) {
      let totalHours = 0;
      let count = 0;

      for (const lead of leads) {
        const msgs = messageMap.get(lead.contactId);
        if (!msgs?.length) continue;

        const leadCreatedAt = new Date(lead.createdAt);

        // first valid message after lead creation
        const first = msgs.find((m) => {
          if (new Date(m.dateAdded) < leadCreatedAt) return false;
          if (messageType && m.messageType !== messageType) return false;
          return true;
        });

        if (!first) continue;

        totalHours +=
          (new Date(first.dateAdded) - leadCreatedAt) / (1000 * 60 * 60);

        count++;
      }

      return count ? totalHours / count : 0;
    }

    const getPipelineIdSet = (clinics, key) => {
      const allIds = clinics.flatMap((c) => c[key]?.map((p) => p.id) || []);
      return new Set(allIds);
    };

    const isLeadInRangeAndStage = (lead, stageSet, startDate, endDate) => {
      if (!stageSet.has(lead.pipelineStageId) || !lead.lastStageChangeAt)
        return false;

      const stageChangeDate = dayjs(lead.lastStageChangeAt)
        .tz(lead.clinicTimezone)
        .format("YYYY-MM-DD");

      return stageChangeDate >= startDate && stageChangeDate <= endDate;
    };

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
                    clinicName: clinic.name,
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
                    clinicName: clinic.name,
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
                    mstDate: new Date(
                      dayjs(m.dateAdded)
                        .tz("America/Denver")
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

          // for (const clinic of clinics) {
          for (const calendarId of clinic.calendarID) {
            const events = await fetchCalendarEvents(clinic, calendarId);

            if (!events.length) continue;

            const ops = events.map((e) => ({
              updateOne: {
                filter: {
                  clinicId: clinic._id,
                  calendarId,
                  remoteEventId: e.id,
                },
                update: {
                  $set: {
                    clinicId: clinic._id,
                    clinicName: clinic.name,
                    calendarId,
                    remoteEventId: e.id,

                    contactId: e.contactId || null,
                    dateAdded: new Date(e.dateAdded),
                    userId: e.createdBy.userId,

                    clinicTimezone: clinic.timezone,
                    dateLocal: dayjs(e.startTime)
                      .tz(clinic.timezone)
                      .format("YYYY-MM-DD"),
                  },
                },
                upsert: true,
              },
            }));

            await db.collection("calendarEvents").bulkWrite(ops);

            console.log(
              `📅 ${clinic.name} | ${calendarId} | ${events.length} events`,
            );
          }
          // }

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

    // multiple clinics with empty clinicIds handle
    // app.get("/opportunities", verifyToken, async (req, res) => {
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
    //       createdAt: { $gte: start, $lte: end },
    //     };
    //   });

    //   if (orConditions.length === 0) return res.send([]);

    //   const opportunities = await opportunitiesCollection
    //     .find({ $or: orConditions })
    //     .toArray();

    //   res.send(opportunities);
    // });

    // app.get("/messages", verifyToken, async (req, res) => {
    //   try {
    //     const { from, to, clinicIds } = req.query;
    //     console.log(from, to);

    //     const ids = clinicIds ? JSON.parse(clinicIds) : [];
    //     if (ids.length === 0) return res.send([]);

    //     const objectIds = ids.map((id) => new ObjectId(id));

    //     const clinics = await clinicCollection
    //       .find({ _id: { $in: objectIds } })
    //       .toArray();

    //     if (clinics.length === 0) return res.send([]);

    //     const orConditions = clinics.map((clinic) => {
    //       // const tz = clinic.timezone || "UTC";
    //       // const tz = "Asia/Dhaka" || "UTC";
    //       const tz = "America/Denver" || "UTC";

    //       const start = dayjs.tz(from, tz).startOf("day").toDate();
    //       const end = dayjs.tz(to, tz).endOf("day").toDate();
    //       console.log(start, end);

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

    app.get("/opportunities", verifyAutomation, async (req, res) => {
      const result = await opportunitiesCollection.find().toArray();
      res.send(result);
    });

    app.get("/messages", verifyAutomation, async (req, res) => {
      const result = await messagesCollection.find().toArray();
      res.send(result);
    });

    app.get("/events", verifyAutomation, async (req, res) => {
      const result = await calendarEventsCollection.find().toArray();
      res.send(result);
    });

    app.get("/calendarEvents", verifyToken, async (req, res) => {
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
          dateAdded: { $gte: start, $lte: end },
        };
      });

      if (orConditions.length === 0) return res.send([]);

      const opportunities = await calendarEventsCollection
        .find({ $or: orConditions })
        .toArray();

      res.send(opportunities);
    });

    app.get("/cdr-report", verifyToken, async (req, res) => {
      try {
        const { from, to, clinicIds } = req.query;

        const ids = clinicIds ? JSON.parse(clinicIds) : [];
        if (!ids.length) return res.send([]);

        const objectIds = ids.map((id) => new ObjectId(id));

        const clinics = await clinicCollection
          .find({ _id: { $in: objectIds } })
          .toArray();

        if (!clinics.length) return res.send([]);

        const buildDateRange = (from, to, tz) => ({
          $gte: dayjs.tz(from, tz).startOf("day").toDate(),
          $lte: dayjs.tz(to, tz).endOf("day").toDate(),
        });

        const opportunityConditions = clinics.map((clinic) => {
          const tz = clinic.timezone || "UTC";

          return {
            clinicId: new ObjectId(clinic._id),
            createdAt: buildDateRange(from, to, tz),
          };
        });

        const messageConditions = clinics.map((clinic) => {
          const tz = "America/Denver"; //message time zone

          return {
            clinicId: new ObjectId(clinic._id),
            dateAdded: buildDateRange(from, to, tz),
          };
        });

        const calendarEventConditions = clinics.map((clinic) => {
          const tz = clinic.timezone || "UTC";

          return {
            clinicId: new ObjectId(clinic._id),
            dateAdded: buildDateRange(from, to, tz),
          };
        });

        const [opportunities, messages, calendarEvents] = await Promise.all([
          opportunitiesCollection
            .find({ $or: opportunityConditions })
            .toArray(),
          messagesCollection.find({ $or: messageConditions }).toArray(),
          calendarEventsCollection
            .find({ $or: calendarEventConditions })
            .toArray(),
        ]);

        const inbound_calls_answer = messages.filter(
          (message) =>
            message.direction === "inbound" &&
            message.messageType === "TYPE_CALL" &&
            message.status === "completed",
        );

        const missed_call = messages.filter(
          (message) =>
            message.direction === "inbound" &&
            message.messageType === "TYPE_CALL" &&
            message.status !== "completed",
        );

        // const outbound_call = countLeadsByFirstResponseTimeRange(
        //   opportunities,
        //   messages,
        //   1,
        //   null,
        //   "TYPE_CALL",
        //   "completed",
        // );

        // const outbound_call = filterLeadsByFirstResponseTimeInOneMInute(
        //   opportunities,
        //   messages,
        // );
        // console.log(outbound_call.length);

        const messageMap = buildMessageMap(messages);

        const outbound_call = filterLeadsByFirstResponseTimeInOneMinuteOptimized(opportunities, messageMap);

        const closePipelineStageIdSet = getPipelineIdSet(
          clinics,
          "close_pipelines",
        );

        const wins = opportunities.filter((lead) =>
          isLeadInRangeAndStage(lead, closePipelineStageIdSet, from, to),
        );

        res.send({
          inbound_calls_answer,
          missed_call,
          outbound_call,
          booked_call: calendarEvents,
          wins,
        });
      } catch (error) {
        res.status(500).send({
          message: "Internal Server Error",
          error: error.message,
        });
      }
    });

    app.get("/qc-report", verifyToken, async (req, res) => {
      try {
        const { from, to, clinicIds, selected } = req.query;

        const ids = clinicIds ? JSON.parse(clinicIds) : [];
        if (!ids.length) return res.send([]);

        const selectedClientsInfo = selected ? JSON.parse(selected) : {};
        if (!selectedClientsInfo) return res.send([]);

        const objectIds = ids.map((id) => new ObjectId(id));

        const clinics = await clinicCollection
          .find({ _id: { $in: objectIds } })
          .toArray();

        if (!clinics.length) return res.send([]);

        const buildDateRange = (from, to, tz) => ({
          $gte: dayjs.tz(from, tz).startOf("day").toDate(),
          $lte: dayjs.tz(to, tz).endOf("day").toDate(),
        });

        const opportunityConditions = clinics.map((clinic) => {
          const tz = clinic.timezone || "UTC";

          return {
            clinicId: new ObjectId(clinic._id),
            createdAt: buildDateRange(from, to, tz),
          };
        });

        const messageConditions = clinics.map((clinic) => {
          const tz = "America/Denver"; //message time zone

          return {
            clinicId: new ObjectId(clinic._id),
            dateAdded: buildDateRange(from, to, tz),
          };
        });

        const calendarEventConditions = clinics.map((clinic) => {
          const tz = clinic.timezone || "UTC";

          return {
            clinicId: new ObjectId(clinic._id),
            dateAdded: buildDateRange(from, to, tz),
          };
        });

        const [opportunities, messages, calendarEvents] = await Promise.all([
          opportunitiesCollection
            .find({ $or: opportunityConditions })
            .toArray(),
          messagesCollection.find({ $or: messageConditions }).toArray(),
          calendarEventsCollection
            .find({ $or: calendarEventConditions })
            .toArray(),
        ]);

        // console.log(selectedClientsInfo?.selectedClients);

        const reports = selectedClientsInfo?.selectedClients?.map((clinic) => {
          const clinicLeads = opportunities.filter(
            (lead) => String(lead.clinicId) === String(clinic.id),
          );

          const clinicMessages = messages.filter(
            (msg) => String(msg.clinicId) === String(clinic.id),
          );

          const clinicCalendarEvents = calendarEvents.filter(
            (event) => String(event.clinicId) === String(clinic.id),
          );
          // console.log(clinicLeads.length,clinicMessages.length, clinicCalendarEvents.length);

          const d1 = dayjs(from);
          const d2 = dayjs(to);
          const diff = d2.diff(d1, "day");

          const working_day = diff;

          const total_of_call = clinicMessages.filter(
            (message) =>
              message.direction === "outbound" &&
              message.messageType === "TYPE_CALL" &&
              message.userId === clinic.userID,
          ).length;

          const OB_call_per_day = Math.round(total_of_call / working_day);

          const total_of_sets = clinicCalendarEvents.length;

          const inbound_calls_total = clinicMessages.filter(
            (message) =>
              message.direction === "inbound" &&
              message.messageType === "TYPE_CALL",
          );

          const inbound_calls_answer = inbound_calls_total.filter(
            (call) => call.status === "completed",
          );

          const IBAR = (
            (inbound_calls_answer.length / inbound_calls_total.length) *
            100
          ).toFixed(2);

          const messageMap = buildMessageMap(clinicMessages);

          // const thirty_plus_minutes_to_respond =
          //   countLeadsByFirstResponseTimeRange(
          //     clinicLeads,
          //     clinicMessages,
          //     30,
          //     null,
          //     "TYPE_CALL",
          //   );

            const thirty_plus_minutes_to_respond = countLeadsByFirstResponseTimeRangeOptimized(clinicLeads, messageMap, 30, null, "TYPE_CALL");

            const with_in_15_minutes = countLeadsByFirstResponseTimeRangeOptimized(clinicLeads, messageMap, 0, 15, "TYPE_CALL");

          // const with_in_15_minutes = countLeadsByFirstResponseTimeRange(
          //   clinicLeads,
          //   clinicMessages,
          //   0,
          //   15,
          //   "TYPE_CALL",
          // );

          const total_leads_reviewed =
            thirty_plus_minutes_to_respond + with_in_15_minutes;

          const percentage_of_leads_w_thirty_plus_mins = (
            (thirty_plus_minutes_to_respond / total_leads_reviewed) *
            100
          ).toFixed(2);

          const percentage_of_leads_with_in_fifteen_mins = (
            (with_in_15_minutes / total_leads_reviewed) *
            100
          ).toFixed(2);

          return {
            office: clinic.name,
            setter: selectedClientsInfo?.name,
            date_range: `${from + " - " + to}`,
            working_day: working_day,
            total_of_call,
            OB_call_per_day,
            total_of_opportunities: clinicLeads.length,

            total_of_sets,
            set_day: working_day ? (total_of_sets / working_day).toFixed(2) : 0,
            lead_to_schedule_ratio:
              total_of_sets > 0
                ? ((total_of_sets / clinicLeads.length) * 100).toFixed(2)
                : 0,

            inbound_calls_total: inbound_calls_total.length,
            inbound_calls_answer: inbound_calls_answer.length,
            IBAR,
            thirty_plus_minutes_to_respond,
            with_in_15_minutes,
            total_leads_reviewed,
            percentage_of_leads_w_thirty_plus_mins,
            percentage_of_leads_with_in_fifteen_mins,
          };
        });

        res.send(reports);
      } catch (error) {
        console.log(error);
        res.status(500).send({
          message: "Internal Server Error",
          error: error.message,
        });
      }
    });

    app.get("/kpi-report", verifyToken, async (req, res) => {
      try {
        const { from, to, startDate, endDate, clinicIds } = req.query;

        const ids = clinicIds ? JSON.parse(clinicIds) : [];
        if (!ids.length) return res.send({});

        const objectIds = ids.map((id) => new ObjectId(id));

        /* ---------------- clinics ---------------- */
        const clinics = await clinicCollection
          .find({ _id: { $in: objectIds } })
          .toArray();

        if (!clinics.length) return res.send({});

        /* ---------------- date range builder ---------------- */
        const buildDateRange = (from, to, tz) => ({
          $gte: dayjs.tz(from, tz).startOf("day").toDate(),
          $lte: dayjs.tz(to, tz).endOf("day").toDate(),
        });

        /* ---------------- db queries ---------------- */
        const opportunityConditions = clinics.map((c) => ({
          clinicId: new ObjectId(c._id),
          createdAt: buildDateRange(from, to, c.timezone || "UTC"),
        }));

        const messageConditions = clinics.map((c) => ({
          clinicId: new ObjectId(c._id),
          dateAdded: buildDateRange(from, to, "America/Denver"),
        }));

        const [leads, messages] = await Promise.all([
          opportunitiesCollection
            .find({ $or: opportunityConditions })
            .toArray(),
          messagesCollection.find({ $or: messageConditions }).toArray(),
        ]);

        /* ---------------- pipeline sets ---------------- */
        const getPipelineIdSet = (key) =>
          new Set(clinics.flatMap((c) => c[key]?.map((p) => p.id) || []));

        const conversationSet = getPipelineIdSet("conversion_pipelines");
        const bookingSet = getPipelineIdSet("booking_pipelines");
        const showingSet = getPipelineIdSet("showing_pipelines");
        const closeSet = getPipelineIdSet("close_pipelines");

        /* ---------------- inbound calls ---------------- */
        const inboundCalls = messages.filter(
          (m) => m.direction === "inbound" && m.messageType === "TYPE_CALL",
        );

        const answeredInboundCalls = inboundCalls.filter(
          (c) => c.status === "completed",
        );

        const inboundCallRate = inboundCalls.length
          ? ((answeredInboundCalls.length / inboundCalls.length) * 100).toFixed(
              2,
            )
          : "0.00";

        /* ---------------- stage range filter ---------------- */
        const isLeadInRangeAndStage = (lead, stageSet) => {
          if (!stageSet.has(lead.pipelineStageId) || !lead.lastStageChangeAt)
            return false;

          const d = dayjs(lead.lastStageChangeAt)
            .tz(lead.clinicTimezone || "UTC")
            .format("YYYY-MM-DD");

          return d >= from && d <= to;
        };

        const conversionLead = leads.filter((l) =>
          isLeadInRangeAndStage(l, conversationSet),
        );
        const totalBooked = leads.filter((l) =>
          isLeadInRangeAndStage(l, bookingSet),
        );
        const showingLead = leads.filter((l) =>
          isLeadInRangeAndStage(l, showingSet),
        );
        const closeLead = leads.filter((l) =>
          isLeadInRangeAndStage(l, closeSet),
        );

        /* ---------------- messages by contact ---------------- */
        const messageByContact = new Map();
        for (const m of messages) {
          if (!messageByContact.has(m.contactId))
            messageByContact.set(m.contactId, []);
          messageByContact.get(m.contactId).push(m);
        }

        const calculateAvgFirstResponseTime = (leads, type) => {
          let total = 0;
          let count = 0;

          for (const lead of leads) {
            const msgs = messageByContact.get(lead.contactId);
            if (!msgs?.length) continue;

            const createdAt = new Date(lead.createdAt);

            const first = msgs
              .filter(
                (m) =>
                  m.dateAdded &&
                  new Date(m.dateAdded) >= createdAt &&
                  (!type || m.messageType === type),
              )
              .sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded))[0];

            if (!first) continue;

            total += (new Date(first.dateAdded) - createdAt) / (1000 * 60 * 60);
            count++;
          }

          return count ? total / count : 0;
        };

        const hoursToDayTime = (hours) => {
          const s = Math.floor(hours * 3600);
          return {
            days: Math.floor(s / 86400),
            hours: Math.floor((s % 86400) / 3600),
            minutes: Math.floor((s % 3600) / 60),
            seconds: s % 60,
          };
        };

        const avgCall = hoursToDayTime(
          calculateAvgFirstResponseTime(leads, "TYPE_CALL"),
        );
        const avgSMS = hoursToDayTime(
          calculateAvgFirstResponseTime(leads, "TYPE_SMS"),
        );

        /* ---------------- monthly KPI ---------------- */
        const getLast12Months = (base) =>
          Array.from({ length: 12 }, (_, i) => {
            const d = dayjs(base).subtract(11 - i, "month");
            return { key: d.format("YYYY-M"), month: d.format("MMM YYYY") };
          });

        const monthlyMap = {};
        getLast12Months(endDate).forEach(
          ({ key, month }) =>
            (monthlyMap[key] = {
              month,
              totalLead: 0,
              conversion: 0,
              booking: 0,
              showing: 0,
              close: 0,
            }),
        );

        for (const lead of leads) {
          const tz = lead.clinicTimezone || "UTC";

          const createdKey = dayjs(lead.createdAt).tz(tz).format("YYYY-M");
          if (monthlyMap[createdKey]) {
            monthlyMap[createdKey].totalLead++;
          }

          if (!lead.lastStageChangeAt) continue;

          const stageKey = dayjs(lead.lastStageChangeAt)
            .tz(tz)
            .format("YYYY-M");
          if (!monthlyMap[stageKey]) continue;

          if (conversationSet.has(lead.pipelineStageId))
            monthlyMap[stageKey].conversion++;

          if (bookingSet.has(lead.pipelineStageId))
            monthlyMap[stageKey].booking++;

          if (showingSet.has(lead.pipelineStageId))
            monthlyMap[stageKey].showing++;

          if (closeSet.has(lead.pipelineStageId)) monthlyMap[stageKey].close++;
        }

        /* ---------------- last 30 days KPI ---------------- */
        const groupByDay = (items, field) => {
          const map = new Map();
          for (const i of items) {
            const key = dayjs(i[field])
              .tz(i.clinicTimezone || "UTC")
              .format("YYYY-MM-DD");
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(i);
          }
          return map;
        };

        const leadMap = groupByDay(leads, "createdAt");
        const messageMap = groupByDay(messages, "dateAdded");

        const totalDays =
          Math.ceil(
            Math.abs(new Date(endDate) - new Date(startDate)) /
              (1000 * 60 * 60 * 24),
          ) + 1;

        const daysToShow = Math.min(totalDays, 30);
        const baseDate = dayjs(endDate);

        const last30DaysKpiRows = [];

        for (let i = 0; i < daysToShow; i++) {
          const dayKey = baseDate.subtract(i, "day").format("YYYY-MM-DD");
          const dailyLeads = leadMap.get(dayKey) || [];
          const dailyMessages = messageMap.get(dayKey) || [];

          let conversion = 0,
            booking = 0,
            showing = 0,
            close = 0;

          for (const l of dailyLeads) {
            if (!l.lastStageChangeAt) continue;
            const d = dayjs(l.lastStageChangeAt)
              .tz(l.clinicTimezone || "UTC")
              .format("YYYY-MM-DD");
            if (d !== dayKey) continue;

            if (conversationSet.has(l.pipelineStageId)) conversion++;
            if (bookingSet.has(l.pipelineStageId)) booking++;
            if (showingSet.has(l.pipelineStageId)) showing++;
            if (closeSet.has(l.pipelineStageId)) close++;
          }

          const inbound = dailyMessages.filter(
            (m) => m.direction === "inbound" && m.messageType === "TYPE_CALL",
          );
          const answered = inbound.filter((m) => m.status === "completed");

          const messageMapForPerDay = buildMessageMap(dailyMessages);

          const avgCall = hoursToDayTime(
            calculateAvgFirstResponseTimeOptimized(
              dailyLeads,
              messageMapForPerDay,
              "TYPE_CALL",
            ),
          );

          const avgSms = hoursToDayTime(
            calculateAvgFirstResponseTimeOptimized(
              dailyLeads,
              messageMapForPerDay,
              "TYPE_SMS",
            ),
          );

          last30DaysKpiRows.push({
            date: dayKey,
            totalLead: dailyLeads.length,
            inboundCallRate: inbound.length
              ? ((answered.length / inbound.length) * 100).toFixed(2)
              : "0.00",
            conversion,
            booking,
            showing,
            close,
            avgCall,
            avgSms,
          });
        }

        /* ---------------- response ---------------- */
        res.send({
          newLeads: leads.length,
          inboundCallRate,
          conversionLead: conversionLead.length,
          totalBooked: totalBooked.length,
          showingLead: showingLead.length,
          closeLead: closeLead.length,
          avgCall,
          avgSMS,
          monthlyData: Object.values(monthlyMap),
          last30DaysKpiRows,
        });
      } catch (error) {
        res.status(500).send({
          message: "Internal Server Error",
          error: error.message,
        });
      }
    });

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
