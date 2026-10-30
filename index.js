const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==========================================
// 🎯 核心分流路由表（核对两个场景的 Webhook）
// ==========================================
const MAKE_ROUTING = {
    // 运营1号 (Danilo's 实例 710722733935) -> 对应场景1
    '710722733935': 'https://hook.us2.make.com/wmldwkxq58x3hww3ua8e4xiimueelnit',
    
    // 运营2号 (商业版 实例 710722775501) -> 对应场景2
    '710722775501': 'https://hook.us2.make.com/knhaajl1aaijqh39f5b5xuff93wwptg6'
};

// 兜底地址（默认推给场景1）
const DEFAULT_MAKE_URL = 'https://hook.us2.make.com/wmldwkxq58x3hww3ua8e4xiimueelnit';

// 获取对应实例要发送的目标 Make 网址
function getTargetUrl(idInstance) {
    return MAKE_ROUTING[String(idInstance)] || DEFAULT_MAKE_URL;
}

// 内存单例防抖池（以 "实例ID_客户手机号" 为独立键，双号绝对隔离）
const bufferMap = new Map();

app.post('/webhook', (req, res) => {
    // 立即向 Green-API 确认 200，防止重试
    res.status(200).send({ status: 'buffered' });

    const body = req.body;
    const idInstance = String(body?.instanceData?.idInstance || '');
    const chatId = body?.senderData?.chatId;

    // 1. 同时抓取文字（普通文字、扩展文字、图片描述 caption）
    const text = body?.messageData?.textMessageData?.textMessage 
              || body?.messageData?.extendedTextMessageData?.text
              || body?.messageData?.fileMessageData?.caption 
              || "";

    // 2. 抓取图片下载直链
    const imageUrl = body?.messageData?.fileMessageData?.downloadUrl || null;

    const targetMakeUrl = getTargetUrl(idInstance);

    // 如果非图文消息（如系统通知、位置等），直接按对应实例转发
    if (!chatId || (!text.trim() && !imageUrl)) {
        if (chatId) {
            axios.post(targetMakeUrl, body).catch(e => console.error(`[${idInstance}] 转发非图文失败:`, e.message));
        }
        return;
    }

    // 🌟 核心防串线：以 "实例ID_客户手机号" 为唯一键
    const bufferKey = `${idInstance}_${chatId}`;

    // 3. 命中滑动窗口：重置 50 秒倒计时
    if (bufferMap.has(bufferKey)) {
        const item = bufferMap.get(bufferKey);
        clearTimeout(item.timer);
        if (text.trim()) item.texts.push(text.trim());
        if (imageUrl) item.imageUrls.push(imageUrl);
        item.lastBody = body; // 保持最新元数据
    } else {
        bufferMap.set(bufferKey, {
            idInstance: idInstance,
            chatId: chatId,
            texts: text.trim() ? [text.trim()] : [],
            imageUrls: imageUrl ? [imageUrl] : [],
            lastBody: body,
            timer: null
        });
    }

    const currentItem = bufferMap.get(bufferKey);

    // 4. 开启 50 秒静默等待窗口
    currentItem.timer = setTimeout(async () => {
        // 纯发图无字时提供默认提示词，防止 Dify 报空错误
        const defaultText = currentItem.imageUrls.length > 0 
            ? "Please inspect this engineering drawing or site photo and provide professional recommendations." 
            : "";
        const mergedText = currentItem.texts.join(' ') || defaultText;
        const finalPayload = currentItem.lastBody;

        if (!finalPayload.messageData) {
            finalPayload.messageData = {};
        }

        // 写入合并后的文字
        if (finalPayload.messageData.textMessageData) {
            finalPayload.messageData.textMessageData.textMessage = mergedText;
        } else if (finalPayload.messageData.extendedTextMessageData) {
            finalPayload.messageData.extendedTextMessageData.text = mergedText;
        } else {
            finalPayload.messageData.textMessageData = { textMessage: mergedText };
        }

        // ==========================================
        // 🌟 自动组装适配 Dify Vision 的图片数组
        // ==========================================
        if (currentItem.imageUrls.length > 0) {
            const latestImage = currentItem.imageUrls[currentItem.imageUrls.length - 1];
            
            finalPayload.attachedImageUrl = latestImage;

            if (!finalPayload.messageData.fileMessageData) {
                finalPayload.messageData.fileMessageData = {};
            }
            finalPayload.messageData.fileMessageData.downloadUrl = latestImage;

            // 构造合法的 Dify 图片数组
            finalPayload.difyFiles = [
                {
                    type: "image",
                    transfer_method: "remote_url",
                    url: latestImage
                }
            ];
        } else {
            // 纯文字时生成空数组，确保 Dify 绝不报错
            finalPayload.difyFiles = [];
        }

        const destinationUrl = getTargetUrl(currentItem.idInstance);

        try {
            console.log(`[图文防抖完成] 账号实例: ${currentItem.idInstance} | 客户: ${currentItem.chatId} | 合并: ${currentItem.texts.length} 段字, ${currentItem.imageUrls.length} 张图 -> 推送至: ${destinationUrl}`);
            await axios.post(destinationUrl, finalPayload);
        } catch (err) {
            console.error(`[推送失败] 实例 ${currentItem.idInstance}:`, err.message);
        } finally {
            bufferMap.delete(bufferKey);
        }
    }, 50000); // 50 秒防抖
});

// 健康检查路由
app.get('/', (req, res) => {
    res.send('WhatsApp Unified Multi-Instance Debounce Gateway is Running Perfectly!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Unified Gateway live on port ${PORT}`));
