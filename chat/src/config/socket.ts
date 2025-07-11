import { Server, Socket } from "socket.io";
import http from "http";
import express from "express";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Maps userId -> socketId
const userSocketMap: Record<string, string> = {};

export const getRecieverSocketId = (recieverId: string): string | undefined => {
  return userSocketMap[recieverId];
};

io.on("connection", (socket: Socket) => {
  console.log("✅ User Connected:", socket.id);

  const userId = socket.handshake.query.userId as string | undefined;

  if (userId && userId !== "undefined") {
    userSocketMap[userId] = socket.id;
    console.log(`📌 User ${userId} mapped to socket ${socket.id}`);
  }

  io.emit("getOnlineUser", Object.keys(userSocketMap));

  if (userId) {
    socket.join(userId);
  }

  // ✏️ Typing indicators
  socket.on("typing", (data) => {
    socket.to(data.chatId).emit("userTyping", {
      chatId: data.chatId,
      userId: data.userId,
    });
  });

  socket.on("stopTyping", (data) => {
    socket.to(data.chatId).emit("userStoppedTyping", {
      chatId: data.chatId,
      userId: data.userId,
    });
  });

  // 💬 Chat room
  socket.on("joinChat", (chatId) => {
    socket.join(chatId);
  });

  socket.on("leaveChat", (chatId) => {
    socket.leave(chatId);
  });

  // ❌ Disconnect cleanup
  socket.on("disconnect", () => {
    console.log("❌ User Disconnected:", socket.id);

    if (userId) {
      delete userSocketMap[userId];
      io.emit("getOnlineUser", Object.keys(userSocketMap));
    }
  });

  socket.on("connect_error", (error) => {
    console.log("⚠️ Socket connection error:", error);
  });
});

export { app, server, io };
