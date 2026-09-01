import { Request, Response } from "express";
import prisma from "../../lib/prisma";

const userSelect = {
  id: true,
  fullName: true,
  profileImageUrl: true,
} as const;

const getAuthUserId = (req: Request): string | undefined => {
  const userFromToken = (req as any).user;
  return userFromToken?.userId || userFromToken?.id;
};

const formatChatUser = (user: { id: string; fullName: string; profileImageUrl: string | null } | null | undefined) => {
  if (!user) return null;
  return {
    id: user.id,
    fullName: user.fullName,
    profileImage: user.profileImageUrl,
    profileImageUrl: user.profileImageUrl,
  };
};

const messagePreview = (message: string) => {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};

const chatEventClients = new Map<string, Set<Response>>();

const writeChatEvent = (client: Response, event: string, data: unknown) => {
  client.write(`event: ${event}\n`);
  client.write(`data: ${JSON.stringify(data)}\n\n`);
};

const notifyUser = (userId: string, event: string, data: unknown) => {
  const clients = chatEventClients.get(userId);
  if (!clients) return;

  for (const client of clients) {
    if (client.writableEnded) {
      clients.delete(client);
      continue;
    }

    try {
      writeChatEvent(client, event, data);
    } catch {
      clients.delete(client);
    }
  }

  if (clients.size === 0) {
    chatEventClients.delete(userId);
  }
};

export const streamChatEvents = async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);

  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let clients = chatEventClients.get(userId);
  if (!clients) {
    clients = new Set<Response>();
    chatEventClients.set(userId, clients);
  }
  clients.add(res);

  writeChatEvent(res, "connected", { success: true });

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      writeChatEvent(res, "ping", { at: new Date().toISOString() });
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clients?.delete(res);
    if (clients?.size === 0) {
      chatEventClients.delete(userId);
    }
  });
};


// Get all chats for the current user
export const getChats = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    
    console.log("Fetching chats for user:", userId);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const chats = await prisma.chat.findMany({
      where: {
        participants: {
          some: {
            userId: userId,
          },
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: userSelect,
            },
          },
        },
        messages: {
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const chatIds = chats.map((chat) => chat.id);
    const unreadGroups = chatIds.length > 0
      ? await prisma.message.groupBy({
          by: ["chatId"],
          where: {
            chatId: { in: chatIds },
            senderId: { not: userId },
            readAt: null,
          },
          _count: { _all: true },
        })
      : [];
    const unreadMap = new Map(unreadGroups.map((group) => [group.chatId, group._count._all]));

    const formattedChats = chats
      .map((chat) => {
        const otherParticipant = chat.participants.find(
          (p) => p.userId !== userId
        )?.user;

        const lastMessage = chat.messages[0];

        return {
          id: chat.id,
          createdAt: chat.createdAt,
          participant: formatChatUser(otherParticipant),
          lastMessage: lastMessage
            ? {
                id: lastMessage.id,
                content: lastMessage.message,
                createdAt: lastMessage.createdAt,
                senderId: lastMessage.senderId,
                isFromMe: lastMessage.senderId === userId,
              }
            : null,
          unreadCount: unreadMap.get(chat.id) || 0,
        };
      })
      .sort((a, b) => {
        const aDate = new Date(a.lastMessage?.createdAt || a.createdAt).getTime();
        const bDate = new Date(b.lastMessage?.createdAt || b.createdAt).getTime();
        return bDate - aDate;
      });

    res.json({ chats: formattedChats });
  } catch (error) {
    console.error("Error in getChats:", error);
    res.status(500).json({ success: false, message: "Failed to fetch chats" });
  }
};

// Get unread count
export const getUnreadCount = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const unreadWhere = {
      senderId: { not: userId },
      readAt: null,
      chat: {
        participants: {
          some: { userId },
        },
      },
    };

    const [unreadCount, latestUnreadMessages] = await Promise.all([
      prisma.message.count({ where: unreadWhere }),
      prisma.message.findMany({
        where: unreadWhere,
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          sender: { select: userSelect },
        },
      }),
    ]);

    res.json({
      count: unreadCount,
      messages: latestUnreadMessages.map((message) => ({
        id: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        message: message.message,
        preview: messagePreview(message.message),
        createdAt: message.createdAt,
        sender: formatChatUser(message.sender),
      })),
    });
  } catch (error) {
    console.error("Error in getUnreadCount:", error);
    res.status(500).json({ success: false, message: "Failed to fetch unread count" });
  }
};

// Create a new chat
export const createChat = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const { participantId } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!participantId) {
      return res.status(400).json({ success: false, message: "Participant ID is required" });
    }

    const otherUserId = String(participantId);

    if (otherUserId === userId) {
      return res.status(400).json({ success: false, message: "Cannot create a conversation with yourself" });
    }

    const participantUser = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: userSelect,
    });

    if (!participantUser) {
      return res.status(404).json({ success: false, message: "Participant not found" });
    }

    // Check if chat already exists
    const existingChat = await prisma.chat.findFirst({
      where: {
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: otherUserId } } },
        ],
      },
    });

    if (existingChat) {
      return res.json({ chatId: existingChat.id, participant: formatChatUser(participantUser) });
    }

    // Create new chat
    const newChat = await prisma.chat.create({
      data: {
        participants: {
          create: [{ userId }, { userId: otherUserId }],
        },
      },
    });

    res.json({ chatId: newChat.id, participant: formatChatUser(participantUser) });
  } catch (error) {
    console.error("Error in createChat:", error);
    res.status(500).json({ success: false, message: "Failed to create chat" });
  }
};

// Get chat by ID
export const getChatById = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    // const { chatId } = req.params;
        const chatId = req.params.id as string;


    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const chat = await prisma.chat.findFirst({
      where: {
        id: chatId,
        participants: { some: { userId } },
      },
      include: {
        participants: {
          include: {
            user: {
              select: userSelect,
            },
          },
        },
      },
    });

    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat not found" });
    }

    const otherParticipant = chat.participants.find(
      (p) => p.userId !== userId
    )?.user;

    res.json({
      chat: {
        id: chat.id,
        createdAt: chat.createdAt,
        participant: formatChatUser(otherParticipant),
      },
    });
  } catch (error) {
    console.error("Error in getChatById:", error);
    res.status(500).json({ success: false, message: "Failed to fetch chat" });
  }
};

// Get messages for a chat - UPDATED with read marking
export const getMessages = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const chatId = req.params.id as string;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Verify user is part of the chat
    const chat = await prisma.chat.findFirst({
      where: {
        id: chatId,
        participants: { some: { userId } },
      },
      include: {
        participants: {
          include: {
            user: { select: userSelect },
          },
        },
      },
    });

    if (!chat) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    // Mark only messages received by the current user as read when this conversation is opened.
    await prisma.message.updateMany({
      where: {
        chatId,
        senderId: { not: userId },
        readAt: null,
      },
      data: {
        readAt: new Date(),
      },
    });

    const messages = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
      include: {
        sender: { select: userSelect },
      },
    });

    const otherParticipant = chat.participants.find(
      (participant) => participant.userId !== userId
    )?.user;

    res.json({
      chat: {
        id: chat.id,
        createdAt: chat.createdAt,
        participant: formatChatUser(otherParticipant),
        participants: chat.participants.map((participant) => {
          const user = formatChatUser(participant.user);
          return {
            userId: participant.userId,
            id: user?.id,
            fullName: user?.fullName,
            profileImage: user?.profileImage,
            profileImageUrl: user?.profileImageUrl,
          };
        }),
      },
      messages: messages.map((message) => ({
        id: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        message: message.message,
        readAt: message.readAt,
        isAi: message.isAi,
        createdAt: message.createdAt,
        sender: formatChatUser(message.sender),
      })),
    });
  } catch (error) {
    console.error("Error in getMessages:", error);
    res.status(500).json({ success: false, message: "Failed to fetch messages" });
  }
};

// Send a message
export const sendMessage = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const chatId = req.params.id as string;
    const { message } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: "Message is required" });
    }

    // Verify user is part of the chat
    const participant = await prisma.chatParticipant.findFirst({
      where: { chatId, userId },
    });

    if (!participant) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const newMessage = await prisma.message.create({
      data: {
        chatId,
        senderId: userId,
        message: message.trim(),
        isAi: false,
      },
      include: {
        sender: { select: userSelect },
      },
    });

    const realtimeMessage = {
      id: newMessage.id,
      chatId: newMessage.chatId,
      senderId: newMessage.senderId,
      message: newMessage.message,
      preview: messagePreview(newMessage.message),
      readAt: newMessage.readAt,
      createdAt: newMessage.createdAt,
      isAi: newMessage.isAi,
      sender: formatChatUser(newMessage.sender),
    };

    const recipients = await prisma.chatParticipant.findMany({
      where: {
        chatId,
        userId: { not: userId },
      },
      select: { userId: true },
    });

    recipients.forEach((recipient) => {
      notifyUser(recipient.userId, "message", realtimeMessage);
    });

    res.json({
      id: realtimeMessage.id,
      chatId: realtimeMessage.chatId,
      senderId: realtimeMessage.senderId,
      message: realtimeMessage.message,
      readAt: realtimeMessage.readAt,
      createdAt: realtimeMessage.createdAt,
      isAi: realtimeMessage.isAi,
      sender: realtimeMessage.sender,
    });
  } catch (error) {
    console.error("Error in sendMessage:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
};
