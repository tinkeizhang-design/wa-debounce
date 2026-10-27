const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ⚠️ 你的 Make.com 接收 Webhook 地址（保持不变）
const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/wmldwkxq58x3hww3ua8e4xiimueelnit';

// 内存单例防抖池（常驻服务器内存，图文双收、100% 共享隔离）
const bufferMap = new Map();

app.post('/webhook', (req, res) => {
    // 立即向 Green-API 确认 200，防止重试
    res.status(200).send({ status: 'buffered' });

    const body = req.body;
    const chatId = body?.senderData?.chatId;

    // 1. 同时抓取文字（普通文字、扩展回复文字、图片附带的描述说明 caption）
    const text = body?.messageData?.textMessageData?.textMessage 
              || body?.messageData?.extendedTextMessageData?.text
              || body?.messageData?.fileMessageData?.caption 
              || "";

    // 2. 抓取图片的公网下载直链（Green-API 官方图床链接）
    const imageUrl = body?.messageData?.fileMessageData?.downloadUrl || null;

    // 如果既没有文字也没有图片（比如位置卡片、系统撤回通知等），不防抖直接原样发给 Make
    if (!chatId || (!text.trim() && !imageUrl)) {
        if (chatId) {
            axios.post(MAKE_WEBHOOK_URL, body).catch(e => console.error('转发非图文消息失败:', e.message));
        }
        return;
    }

    // 3. 命中同一个客户：滑动时间窗口（重置 50 秒倒计时）
    if (bufferMap.has(chatId)) {
        const item = bufferMap.get(chatId);
        clearTimeout(item.timer);
        if (text.trim()) item.texts.push(text.trim());
        if (imageUrl) item.imageUrls.push(imageUrl); // 收集期间发的所有图片
        item.lastBody = body; // 保持最新元数据
    } else {
        bufferMap.set(chatId, {
            texts: text.trim() ? [text.trim()] : [],
            imageUrls: imageUrl ? [imageUrl] : [],
            lastBody: body,
            timer: null
        });
    }

    const currentItem = bufferMap.get(chatId);

    // 4. 开启 50 秒静默等待窗口（老外彻底停下来 50 秒后，图文打包发车）
    currentItem.timer = setTimeout(async () => {
        const mergedText = currentItem.texts.join(' ');
        const finalPayload = currentItem.lastBody;

        // 确保数据结构完整
        if (!finalPayload.messageData) {
            finalPayload.messageData = {};
        }

        // 把合并好的所有文字写回数据包
        if (finalPayload.messageData.textMessageData) {
            finalPayload.messageData.textMessageData.textMessage = mergedText;
        } else if (finalPayload.messageData.extendedTextMessageData) {
            finalPayload.messageData.extendedTextMessageData.text = mergedText;
        } else {
            // 如果最后一条发的是图片，注入合并好的文字进 textMessageData
            finalPayload.messageData.textMessageData = { textMessage: mergedText };
        }

        // 如果期间收到过图片，把最新的图片直链带上
        if (currentItem.imageUrls.length > 0) {
            const latestImage = currentItem.imageUrls[currentItem.imageUrls.length - 1];
            
            // 顶层挂载方便读取的字段
            finalPayload.attachedImageUrl = latestImage;

            // 同时写入标准 fileMessageData，确保兼容
            if (!finalPayload.messageData.fileMessageData) {
                finalPayload.messageData.fileMessageData = {};
            }
            finalPayload.messageData.fileMessageData.downloadUrl = latestImage;
        }

        try {
            console.log(`[图文防抖打包完成] 用户 ${chatId}: 累计 ${currentItem.texts.length} 段文字, ${currentItem.imageUrls.length} 张图片 -> 发往 Make`);
            await axios.post(MAKE_WEBHOOK_URL, finalPayload);
        } catch (err) {
            console.error('推送给 Make 失败:', err.message);
        } finally {
            bufferMap.delete(chatId);
        }
    }, 50000); // 保持你设定的 50 秒防抖窗口
});

// 健康检查根路由
app.get('/', (req, res) => {
    res.send('WhatsApp Multimodal Debounce Gateway is Running Perfectly!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Debounce service live on port ${PORT}`));
