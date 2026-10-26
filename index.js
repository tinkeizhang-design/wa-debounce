const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ⚠️ 确认这是你 Make.com 原本接收消息的 Webhook 地址
const MAKE_WEBHOOK_URL = 'https://hook.us2.make.com/wmldwkxq58x3hww3ua8e4xiimueelnit';

// 内存单例防抖池（常驻服务器内存，100% 共享、不串线！）
const bufferMap = new Map();

app.post('/webhook', (req, res) => {
    // 立即向 Green-API 确认 200，防止重试
    res.status(200).send({ status: 'buffered' });

    const body = req.body;
    const chatId = body?.senderData?.chatId;
    const text = body?.messageData?.textMessageData?.textMessage 
              || body?.messageData?.extendedTextMessageData?.text;

    // 如果不是纯文本（如纯图片），直接原样转发给 Make
    if (!chatId || !text) {
        axios.post(MAKE_WEBHOOK_URL, body).catch(e => console.error('转发非文本失败:', e.message));
        return;
    }

    // 命中同一个用户：清除旧定时器，重置倒计时（滑动时间窗口）
    if (bufferMap.has(chatId)) {
        const item = bufferMap.get(chatId);
        clearTimeout(item.timer);
        item.texts.push(text);
        item.lastBody = body; // 保持最新元数据
    } else {
        bufferMap.set(chatId, {
            texts: [text],
            lastBody: body,
            timer: null
        });
    }

    const currentItem = bufferMap.get(chatId);

    // 开启 20 秒打字等待窗口（老外20秒内不打字了，才统一打包发车）
    currentItem.timer = setTimeout(async () => {
        const mergedText = currentItem.texts.join(' ');
        const finalPayload = currentItem.lastBody;

        // 把合并好的整段话写回数据包（同时支持普通文本和扩展文本）
        if (finalPayload.messageData?.textMessageData) {
            finalPayload.messageData.textMessageData.textMessage = mergedText;
        }
        if (finalPayload.messageData?.extendedTextMessageData) {
            finalPayload.messageData.extendedTextMessageData.text = mergedText;
        }

        try {
            console.log(`[成功防抖合并] 用户 ${chatId}: 共 ${currentItem.texts.length} 条消息合并为: "${mergedText}"`);
            await axios.post(MAKE_WEBHOOK_URL, finalPayload);
        } catch (err) {
            console.error('推送给 Make 失败:', err.message);
        } finally {
            bufferMap.delete(chatId);
        }
    }, 50000); // 50000 毫秒 = 50 秒等待
});

// 健康检查根路由
app.get('/', (req, res) => {
    res.send('WhatsApp Debounce Gateway is Running Perfectly!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Debounce service live on port ${PORT}`));
