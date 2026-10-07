import { createContext, useContext, type ReactNode } from "react";
import type { TaskPriority, TaskStatus } from "./types";

export type TaskboardLanguage = "zh" | "en";

interface TaskboardI18n {
  language: TaskboardLanguage;
  locale: "zh-TW" | "en";
  text: (chinese: string, english: string) => string;
}

// The product keeps one source string for the Chinese UI. Convert it at the
// presentation boundary so newly added controls cannot silently reintroduce
// Simplified Chinese in one of the many text()/aria-label/title call sites.
const SIMPLIFIED_TRADITIONAL_PAIRS = `
万萬 与與 专專 业業 东東 丝絲 丢丟 两兩 严嚴 个個 临臨 为為 举舉 义義 习習 乡鄉 书書 买買 乱亂 争爭 亏虧 亚亞 产產 亩畝 亲親 仅僅 从從 仓倉 仪儀 们們 优優 会會 传傳 伤傷 伦倫 体體 余餘 侧側 侦偵 侣侶 侨僑 俩倆 债債 倾傾 偿償 储儲 儿兒 党黨 关關 兴興 养養 军軍 农農 冲衝 决決 几幾 凭憑 击擊 划劃 则則 刚剛 创創 别別 剂劑 剧劇 办辦 动動 务務 励勵 势勢 区區 医醫 协協 卖賣 卫衛 压壓 厅廳 历歷 厉厲 县縣 参參 双雙 发發 变變 叠疊 叶葉 号號 后後 吗嗎 听聽 启啟 员員 团團 园園 围圍 图圖 场場 坏壞 坚堅 坛壇 处處 备備 复復 够夠 头頭 夹夾 奋奮 奖獎 奥奧 妆妝 妈媽 娇嬌 娱娛 婴嬰 学學 宁寧 宝寶 实實 审審 宪憲 导導 将將 尽盡 层層 岁歲 岗崗 巩鞏 币幣 师師 帐帳 带帶 帮幫 广廣 庆慶 库庫 应應 庙廟 废廢 开開 异異 弃棄 张張 强強 弹彈 当當 录錄 彻徹 径徑 忆憶 忧憂 怀懷 态態 总總 恋戀 恳懇 悦悅 惧懼 惨慘 惩懲 惯慣 愤憤 懒懶 戏戲 战戰 户戶 执執 扩擴 扫掃 扬揚 扰擾 护護 报報 担擔 拟擬 拦攔 拢攏 择擇 挡擋 挣掙 挤擠 换換 掺摻 携攜 摆擺 摇搖 数數 斋齋 断斷 无無 旧舊 时時 显顯 晓曉 暂暫 术術 机機 权權 杀殺 极極 构構 枪槍 柜櫃 标標 栏欄 树樹 样樣 桥橋 梦夢 检檢 楼樓 欢歡 残殘 毕畢 气氣 汇匯 汉漢 污污 沟溝 没沒 泪淚 洁潔 洒灑 浇澆 测測 浑渾 浓濃 涂塗 涛濤 涡渦 涨漲 渐漸 温溫 湿濕 满滿 滤濾 滥濫 潜潛 灯燈 灵靈 灾災 炉爐 点點 炼煉 烧燒 热熱 焕煥 爱愛 爷爺 牵牽 犹猶 独獨 猎獵 猪豬 献獻 环環 现現 电電 画畫 畅暢 疗療 疯瘋 瘾癮 矫矯 确確 碍礙 礼禮 祸禍 离離 种種 积積 称稱 稳穩 穷窮 窃竊 竞競 笔筆 签簽 简簡 类類 约約 红紅 纪紀 纯純 纲綱 线線 组組 终終 练練 绍紹 结結 给給 绝絕 统統 继繼 绩績 缓緩 缩縮 缴繳 网網 罗羅 罚罰 职職 联聯 聪聰 肃肅 胜勝 脉脈 脑腦 舰艦 艺藝 节節 苍蒼 苏蘇 范範 荐薦 药藥 获獲 营營 虑慮 虚虛 虽雖 蚀蝕 蛮蠻 补補 装裝 见見 观觀 规規 视視 览覽 觉覺 触觸 计計 认認 议議 讯訊 记記 讲講 许許 论論 设設 访訪 证證 评評 词詞 译譯 试試 诗詩 诚誠 话話 该該 详詳 语語 说說 请請 读讀 谁誰 调調 谈談 谓謂 谢謝 谣謠 谱譜 贝貝 负負 贡貢 财財 败敗 货貨 质質 购購 贤賢 贫貧 贴貼 贵貴 费費 贺賀 资資 赋賦 赏賞 赔賠 赖賴 赞贊 赠贈 赵趙 赶趕 轻輕 转轉 轮輪 软軟 辅輔 辞辭 边邊 达達 迁遷 过過 迈邁 还還 这這 进進 远遠 违違 连連 迟遲 适適 选選 逊遜 递遞 逻邏 遗遺 释釋 链鏈 锁鎖 键鍵 错錯 镜鏡 长長 闭閉 问問 间間 闷悶 阅閱 队隊 阳陽 阴陰 阵陣 际際 陆陸 险險 随隨 隐隱 难難 雏雛 雾霧 静靜 须須 顶頂 顺順 预預 领領 频頻 题題 颜顏 风風 飞飛 饭飯 饮飲 饱飽 馆館 驳駁 验驗 骂罵 驱驅 驶駛 鱼魚 鸟鳥 鸡雞 鸭鴨 鹅鵝 麦麥 黄黃 齐齊 齿齒 龙龍 龟龜 项項 删刪 对對 经經 络絡 运運 归歸 档檔 据據 误誤 响響 筛篩 条條 属屬 内內 页頁 减減 状狀 复復 绪緒 载載 级級 钟鐘 并並 续續
`.trim().split(/\s+/);

const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = Object.fromEntries(
  SIMPLIFIED_TRADITIONAL_PAIRS.map((pair) => [pair[0], pair[1]]),
);

export function toTraditionalChinese(value: string): string {
  const phraseNormalized = value
    .replaceAll("复制", "複製")
    .replaceAll("恢复", "恢復")
    .replaceAll("重复", "重複")
    .replaceAll("回复", "回覆")
    .replaceAll("默认", "預設")
    .replaceAll("计划", "計畫")
    .replaceAll("复核", "複核")
    .replaceAll("复选", "複選")
    .replaceAll("复原", "復原");
  return Array.from(phraseNormalized, (character) => SIMPLIFIED_TO_TRADITIONAL[character] ?? character).join("");
}

const I18N: Record<TaskboardLanguage, TaskboardI18n> = {
  zh: {
    language: "zh",
    locale: "zh-TW",
    text: (chinese) => toTraditionalChinese(chinese),
  },
  en: {
    language: "en",
    locale: "en",
    text: (_chinese, english) => english,
  },
};

const STATUS_LABELS: Record<TaskboardLanguage, Record<TaskStatus, string>> = {
  zh: {
    backlog: "待立項",
    todo: "等待認領",
    in_progress: "處理中",
    in_review: "等你確認",
    blocked: "遇到阻礙",
    done: "完成",
    canceled: "取消",
  },
  en: {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
  },
};

const PRIORITY_LABELS: Record<TaskboardLanguage, Record<TaskPriority, string>> = {
  zh: {
    none: "無優先級",
    urgent: "緊急",
    high: "高",
    medium: "中",
    low: "低",
  },
  en: {
    none: "No priority",
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
};

const TaskboardLanguageContext = createContext<TaskboardLanguage>("en");

export function resolveTaskboardLanguage(value: string | null | undefined): TaskboardLanguage {
  const normalized = value?.trim().replaceAll("_", "-").toLowerCase() ?? "";
  return normalized === "zh" || normalized.startsWith("zh-") ? "zh" : "en";
}

export function getTaskboardI18n(language: TaskboardLanguage): TaskboardI18n {
  return I18N[language];
}

export function taskStatusLabel(language: TaskboardLanguage, status: TaskStatus): string {
  return STATUS_LABELS[language][status];
}

export function taskPriorityLabel(language: TaskboardLanguage, priority: TaskPriority): string {
  return PRIORITY_LABELS[language][priority];
}

export function TaskboardLanguageProvider({
  language,
  children,
}: {
  language: TaskboardLanguage;
  children: ReactNode;
}) {
  return (
    <TaskboardLanguageContext.Provider value={language}>
      {children}
    </TaskboardLanguageContext.Provider>
  );
}

export function useTaskboardI18n(): TaskboardI18n {
  return I18N[useContext(TaskboardLanguageContext)];
}
