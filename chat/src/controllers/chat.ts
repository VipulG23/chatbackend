import axios from "axios";
import TryCatch from "../config/TryCatch.js";
import { AuthenticatedRequest } from "../middlewares/isAuth.js";
import { Chat } from "../models/Chat.js";
import { Messages } from "../models/Messages.js";
import { getRecieverSocketId, io } from "../config/socket.js";
import { Response, NextFunction } from "express";

// Create new chat
export const createNewChat = TryCatch(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const { otherUserId } = req.body;

    console.log("Create Chat Request:", { userId, otherUserId });

    if (!otherUserId || userId?.toString() === otherUserId.toString()) {
      console.warn("Invalid otherUserId");
      return res.status(400).json({ message: "Invalid otherUserId" });
    }

    const existingChat = await Chat.findOne({
      users: { $all: [userId, otherUserId], $size: 2 },
    });

    if (existingChat) {
      console.log("Existing chat found:", existingChat._id);
      return res.json({
        message: "Chat already exist",
        chatId: existingChat._id,
      });
    }

    const newChat = await Chat.create({ users: [userId, otherUserId] });
    console.log("New chat created:", newChat._id);

    return res.status(201).json({
      message: "New Chat created",
      chatId: newChat._id,
    });
  }
);

// Get all chats
export const getAllChats = TryCatch(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    console.log("Fetching chats for:", userId);

    if (!userId) {
      console.warn("Missing userId");
      return res.status(400).json({ message: "UserId missing" });
    }

    const chats = await Chat.find({ users: userId }).sort({ updatedAt: -1 });
    console.log(`Found ${chats.length} chats`);

    const chatWithUserData = await Promise.all(
      chats.map(async (chat) => {
        let otherUserId = chat.users.find(
          (id) => id.toString() !== userId.toString()
        );

        if (!otherUserId) {
          console.warn("Self chat detected, using fallback");
          otherUserId = userId;
        }

        const unseenCount = await Messages.countDocuments({
          chatId: chat._id,
          sender: { $ne: userId },
          seen: false,
        });

        console.log("Unseen count for chat", chat._id, unseenCount);

        try {
          const { data } = await axios.get(
            `${process.env.USER_SERVICE}/api/v1/user/${otherUserId}`
          );

          return {
            user: data,
            chat: {
              ...chat.toObject(),
              latestMessage: chat.latestMessage || null,
              unseenCount,
            },
          };
        } catch (error: any) {
          console.error("Error fetching user data:", error?.message || error);
          return {
            user: { _id: otherUserId, name: "Unknown User" },
            chat: {
              ...chat.toObject(),
              latestMessage: chat.latestMessage || null,
              unseenCount,
            },
          };
        }
      })
    );

    console.log(
      "Final Chat Response:",
      JSON.stringify(chatWithUserData, null, 2)
    );

    return res.json({ chats: chatWithUserData });
  }
);

// Send message
export const sendMessage = TryCatch(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const senderId = req.user?._id;
    const { chatId, text } = req.body;
    const imageFile = req.file;

    console.log("SendMessage Request:", { senderId, chatId, text, imageFile });

    if (!senderId) {
      return res.status(401).json({ message: "unauthorized" });
    }

    if (!chatId) {
      return res.status(400).json({ message: "ChatId Required" });
    }

    if (!text && !imageFile) {
      return res
        .status(400)
        .json({ message: "Either text or image is required" });
    }

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const isUserInChat = chat.users.some(
      (userId) => userId.toString() === senderId.toString()
    );

    if (!isUserInChat) {
      return res
        .status(403)
        .json({ message: "You are not a participant of this chat" });
    }

    const otherUserId = chat.users.find(
      (userId) => userId.toString() !== senderId.toString()
    );

    if (!otherUserId) {
      return res.status(401).json({ message: "No other user" });
    }

    const receiverSocketId = getRecieverSocketId(otherUserId.toString());
    let isReceiverInChatRoom = false;

    if (receiverSocketId) {
      const receiverSocket = io.sockets.sockets.get(receiverSocketId);
      if (receiverSocket && receiverSocket.rooms.has(chatId)) {
        isReceiverInChatRoom = true;
      }
    }

    const messageData: any = {
      chatId,
      sender: senderId,
      seen: isReceiverInChatRoom,
      seenAt: isReceiverInChatRoom ? new Date() : undefined,
    };

    if (imageFile) {
      messageData.image = {
        url: imageFile.path,
        publicId: imageFile.filename,
      };
      messageData.messageType = "image";
      messageData.text = text || "";
    } else {
      messageData.text = text;
      messageData.messageType = "text";
    }

    const message = new Messages(messageData);
    const savedMessage = await message.save();

    console.log("Saved Message:", savedMessage);

    const latestMessageText = imageFile ? "📷 Image" : text;

    await Chat.findByIdAndUpdate(
      chatId,
      {
        latestMessage: {
          text: latestMessageText,
          sender: senderId,
        },
        updatedAt: new Date(),
      },
      { new: true }
    );

    io.to(chatId).emit("newMessage", savedMessage);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", savedMessage);
    }

    const senderSocketId = getRecieverSocketId(senderId.toString());
    if (senderSocketId) {
      io.to(senderSocketId).emit("newMessage", savedMessage);
    }

    if (isReceiverInChatRoom && senderSocketId) {
      io.to(senderSocketId).emit("messagesSeen", {
        chatId: chatId,
        seenBy: otherUserId,
        messageIds: [savedMessage._id],
      });
    }

    return res.status(201).json({
      message: savedMessage,
      sender: senderId,
    });
  }
);

// Get messages by chat
export const getMessagesByChat = TryCatch(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userId = req.user?._id;
    const { chatId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!chatId) {
      return res.status(400).json({ message: "ChatId Required" });
    }

    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const isUserInChat = chat.users.some(
      (chatUserId) => chatUserId.toString() === userId.toString()
    );

    if (!isUserInChat) {
      return res
        .status(403)
        .json({ message: "You are not a participant of this chat" });
    }

    const messagesToMarkSeen = await Messages.find({
      chatId,
      sender: { $ne: userId },
      seen: false,
    });

    await Messages.updateMany(
      {
        chatId,
        sender: { $ne: userId },
        seen: false,
      },
      {
        seen: true,
        seenAt: new Date(),
      }
    );

    const messages = await Messages.find({ chatId }).sort({ createdAt: 1 });

    const otherUserId = chat.users.find(
      (id) => id.toString() !== userId.toString()
    );

    if (!otherUserId) {
      return res.status(400).json({ message: "No other user found" });
    }

    try {
      const { data } = await axios.get(
        `${process.env.USER_SERVICE}/api/v1/user/${otherUserId}`
      );

      if (messagesToMarkSeen.length > 0) {
        const otherUserSocketId = getRecieverSocketId(otherUserId.toString());
        if (otherUserSocketId) {
          io.to(otherUserSocketId).emit("messagesSeen", {
            chatId,
            seenBy: userId,
            messageIds: messagesToMarkSeen.map((msg) => msg._id),
          });
        }
      }

      return res.json({
        messages,
        user: data,
      });
    } catch (error: any) {
      console.log("Error fetching other user:", error?.message || error);

      return res.json({
        messages,
        user: { _id: otherUserId, name: "Unknown User" },
      });
    }
  }
);
