import axios from "axios";
import TryCatch from "../config/TryCatch.js";
import { AuthenticatedRequest } from "../middlewares/isAuth.js";
import { Chat } from "../models/Chat.js";
import { Messages } from "../models/Messages.js";
import { getRecieverSocketId,io } from "../config/socket.js";

export const createNewChat = TryCatch(
  async (req: AuthenticatedRequest, res) => {
    const userId = req.user?._id;
    const { otherUserId } = req.body;

    console.log("Create Chat Request:", { userId, otherUserId });

    if (!otherUserId || userId?.toString() === otherUserId.toString()) {
      console.warn("Invalid otherUserId");
      res.status(400).json({
        message: "Invalid otherUserId",
      });
      return;
    }

    const existingChat = await Chat.findOne({
      users: { $all: [userId, otherUserId], $size: 2 },
    });

    if (existingChat) {
      console.log("Existing chat found:", existingChat._id);
      res.json({
        message: "Chat already exist",
        chatId: existingChat._id,
      });
      return;
    }

    const newChat = await Chat.create({
      users: [userId, otherUserId],
    });

    console.log("New chat created:", newChat._id);

    res.status(201).json({
      message: "New Chat created",
      chatId: newChat._id,
    });
  }
);

export const getAllChats = TryCatch(async (req: AuthenticatedRequest, res) => {
  const userId = req.user?._id;
  console.log("Fetching chats for:", userId);

  if (!userId) {
    console.warn("Missing userId");
    res.status(400).json({ message: "UserId missing" });
    return;
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
        console.log("Fetched user data for chat:", chat._id);

        return {
          user: data,
          chat: {
            ...chat.toObject(),
            latestMessage: chat.latestMessage || null,
            unseenCount,
          },
        };
      } catch (error) {
        console.error("Error fetching user data:", error.message);
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

  res.json({
    chats: chatWithUserData,
  });
});

export const sendMessage = TryCatch(async (req: AuthenticatedRequest, res) => {
  const senderId = req.user?._id;
  const { chatId, text } = req.body;
  const imageFile = req.file;

  console.log("SendMessage Request:", { senderId, chatId, text, imageFile });

  if (!senderId) {
    console.warn("Unauthorized request");
    res.status(401).json({ message: "unauthorized" });
    return;
  }

  if (!chatId) {
    res.status(400).json({ message: "ChatId Required" });
    return;
  }
  

  if (!text && !imageFile) {
    console.warn("Empty message");
    res.status(400).json({ message: "Either text or image is required" });
    return;
  }

  const chat = await Chat.findById(chatId);
  if (!chat) {
    console.warn("Chat not found");
    res.status(404).json({ message: "Chat not found" });
    return;
  }

  const isUserInChat = chat.users.some(
    (userId) => userId.toString() === senderId.toString()
  );
  if (!isUserInChat) {
    console.warn("User not in chat");
    res.status(403).json({ message: "You are not a participant of this chat" });
    return;
  }

  const otherUserId = chat.users.find(
    (userId) => userId.toString() !== senderId.toString()
  );

  if (!otherUserId) {
    console.warn("Other user not found");
    res.status(401).json({ message: "No other user" });
    return;
  }

  const receiverSocketId = getRecieverSocketId(otherUserId.toString());
  let isReceiverInChatRoom = false;

  if (receiverSocketId) {
    const receiverSocket = io.sockets.sockets.get(receiverSocketId);
    if (receiverSocket && receiverSocket.rooms.has(chatId)) {
      isReceiverInChatRoom = true;
    }
  }

  let messageData: any = {
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

  console.log("Updated chat latestMessage");
  
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

  res.status(201).json({
    message: savedMessage,
    sender: senderId,
  });
});

export const getMessagesByChat = TryCatch(
  async (req: AuthenticatedRequest, res) => {
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

    // ✅ Fix: Correct comparison logic
    const isUserInChat = chat.users.some(
      (chatUserId) => chatUserId.toString() === userId.toString()
    );

    if (!isUserInChat) {
      return res.status(403).json({
        message: "You are not a participant of this chat",
      });
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

    try {
      const { data } = await axios.get(
        `${process.env.USER_SERVICE}/api/v1/user/${otherUserId}`
      );

      if (messagesToMarkSeen.length > 0) {
        const otherUserSocketId = getRecieverSocketId(otherUserId.toString());
        if (otherUserSocketId) {
          io.to(otherUserSocketId).emit("messagesSeen", {
            chatId: chatId,
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
