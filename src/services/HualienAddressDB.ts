/**
 * HualienAddressDB - 花蓮在地地址資料庫
 *
 * 150+ 筆人工驗證地標，支援台語腔調別名（Whisper STT 容錯）。
 * 作為 Google Geocoding / Places API 之前的第一層快速比對，節省 API 配額。
 */

// ========== 類型定義 ==========

export interface LandmarkEntry {
  name: string;             // 正式全名
  lat: number | null;       // 精確緯度（人工驗證）
  lng: number | null;       // 精確經度
  address: string;          // 完整地址
  category: 'TRANSPORT' | 'MEDICAL' | 'SCHOOL' | 'COMMERCIAL' |
            'GOVERNMENT' | 'ATTRACTION' | 'HOTEL' | 'TOWNSHIP';
  aliases: string[];        // 簡稱/俗稱
  taigiAliases: string[];   // Whisper 台語腔調可能轉出的同音字
  priority: number;         // 0-10，越高越優先
  district: string;         // 所屬行政區（給 Geocoding 補前綴用）
}

export interface LookupResult {
  entry: LandmarkEntry;
  matchedAlias: string;
  matchType: 'EXACT' | 'ALIAS' | 'TAIGI' | 'SUBSTRING';
  confidence: number;
}

// ========== 地標資料庫 ==========

const LANDMARKS: LandmarkEntry[] = [

  // ================================================
  // 交通（11 筆）
  // ================================================
  {
    name: '花蓮火車站',
    lat: 24.0007, lng: 121.6161,
    address: '花蓮縣花蓮市站前路',
    category: 'TRANSPORT',
    aliases: ['火車站', '車站', '花蓮站', '車頭', '火車頭', '站前', '前站'],
    taigiAliases: ['火車頭', '車頭', '花蓮車頭'],
    priority: 9, district: '花蓮市'
  },
  {
    name: '花蓮火車站後站',
    lat: 23.9988, lng: 121.6098,
    address: '花蓮縣花蓮市富安路100號',
    category: 'TRANSPORT',
    aliases: ['後站', '西站', '花蓮後站', '花蓮西站'],
    taigiAliases: [],
    priority: 8, district: '花蓮市'
  },
  {
    name: '花蓮航空站',
    lat: 24.0238, lng: 121.6165,
    address: '花蓮縣花蓮市嘉里路一段8號',
    category: 'TRANSPORT',
    aliases: ['機場', '航空站', '花蓮機場', '飛機場', '嘉里機場'],
    taigiAliases: ['飛機場', '飛機厝'],
    priority: 8, district: '花蓮市'
  },
  {
    name: '花蓮港',
    lat: 23.9921, lng: 121.6286,
    address: '花蓮縣花蓮市港口',
    category: 'TRANSPORT',
    aliases: ['港口', '花蓮漁港', '漁港'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '花蓮轉運站',
    lat: 24.0002, lng: 121.6123,
    address: '花蓮縣花蓮市國聯一路',
    category: 'TRANSPORT',
    aliases: ['轉運站', '客運站', '花蓮客運'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '新城火車站',
    lat: 24.1312, lng: 121.6588,
    address: '花蓮縣新城鄉新城村',
    category: 'TRANSPORT',
    aliases: ['新城站', '新城車站'],
    taigiAliases: [],
    priority: 5, district: '新城鄉'
  },
  {
    name: '吉安火車站',
    lat: 23.9768, lng: 121.5854,
    address: '花蓮縣吉安鄉',
    category: 'TRANSPORT',
    aliases: ['吉安站', '吉安車站'],
    taigiAliases: [],
    priority: 5, district: '吉安鄉'
  },
  {
    name: '志學火車站',
    lat: 23.9292, lng: 121.5605,
    address: '花蓮縣壽豐鄉志學村',
    category: 'TRANSPORT',
    aliases: ['志學站', '東華站'],
    taigiAliases: [],
    priority: 5, district: '壽豐鄉'
  },
  {
    name: '壽豐火車站',
    lat: 23.8613, lng: 121.5306,
    address: '花蓮縣壽豐鄉壽豐村',
    category: 'TRANSPORT',
    aliases: ['壽豐站'],
    taigiAliases: [],
    priority: 4, district: '壽豐鄉'
  },
  {
    name: '光復火車站',
    lat: 23.6721, lng: 121.4431,
    address: '花蓮縣光復鄉光復村',
    category: 'TRANSPORT',
    aliases: ['光復站'],
    taigiAliases: [],
    priority: 4, district: '光復鄉'
  },
  {
    name: '瑞穗火車站',
    lat: 23.4991, lng: 121.3729,
    address: '花蓮縣瑞穗鄉瑞穗村',
    category: 'TRANSPORT',
    aliases: ['瑞穗站'],
    taigiAliases: [],
    priority: 4, district: '瑞穗鄉'
  },
  {
    name: '玉里火車站',
    lat: 23.3368, lng: 121.3094,
    address: '花蓮縣玉里鎮',
    category: 'TRANSPORT',
    aliases: ['玉里站'],
    taigiAliases: [],
    priority: 5, district: '玉里鎮'
  },

  // ================================================
  // 醫療（11 筆）
  // ================================================
  {
    name: '花蓮慈濟醫院',
    lat: 24.0135, lng: 121.5913,
    address: '花蓮縣花蓮市中央路三段707號',
    category: 'MEDICAL',
    aliases: ['慈濟', '慈濟醫院', '慈院', '中央路醫院'],
    taigiAliases: ['祠際', '磁際', '資際', '茲際', '慈際', '祠際醫院', '磁際醫院'],
    priority: 10, district: '花蓮市'
  },
  {
    name: '門諾醫院',
    lat: 23.9769, lng: 121.6063,
    address: '花蓮縣花蓮市民權路44號',
    category: 'MEDICAL',
    aliases: ['門諾', '民權路醫院', '門諾會醫院'],
    taigiAliases: ['文諾醫院', '門諾醫院', '門若'],
    priority: 9, district: '花蓮市'
  },
  {
    name: '衛生福利部花蓮醫院',
    lat: 23.9767, lng: 121.6084,
    address: '花蓮縣花蓮市中正路600號',
    category: 'MEDICAL',
    aliases: ['部立醫院', '部立', '花蓮醫院', '衛福部醫院', '中正路醫院'],
    taigiAliases: ['部仔醫院'],
    priority: 8, district: '花蓮市'
  },
  {
    name: '花蓮縣立醫院',
    lat: 23.9841, lng: 121.6093,
    address: '花蓮縣花蓮市中山路438號',
    category: 'MEDICAL',
    aliases: ['縣立醫院', '縣醫'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '國軍花蓮總醫院',
    lat: 23.9929, lng: 121.6102,
    address: '花蓮縣花蓮市介壽路163號',
    category: 'MEDICAL',
    aliases: ['國軍醫院', '軍醫院', '花蓮總醫院', '介壽路醫院'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '玉里榮民醫院',
    lat: 23.3294, lng: 121.3060,
    address: '花蓮縣玉里鎮新興路91號',
    category: 'MEDICAL',
    aliases: ['玉里榮總', '榮民醫院', '玉里醫院'],
    taigiAliases: [],
    priority: 6, district: '玉里鎮'
  },
  {
    name: '吉安衛生所',
    lat: 23.9722, lng: 121.5879,
    address: '花蓮縣吉安鄉吉安村吉安路二段216號',
    category: 'MEDICAL',
    aliases: ['吉安衛生所'],
    taigiAliases: [],
    priority: 4, district: '吉安鄉'
  },
  {
    name: '壽豐衛生所',
    lat: 23.8590, lng: 121.5282,
    address: '花蓮縣壽豐鄉壽豐路一段88號',
    category: 'MEDICAL',
    aliases: ['壽豐衛生所'],
    taigiAliases: [],
    priority: 4, district: '壽豐鄉'
  },
  {
    name: '光復衛生所',
    lat: 23.6741, lng: 121.4420,
    address: '花蓮縣光復鄉大馬路62號',
    category: 'MEDICAL',
    aliases: ['光復衛生所'],
    taigiAliases: [],
    priority: 4, district: '光復鄉'
  },
  {
    name: '瑞穗衛生所',
    lat: 23.5001, lng: 121.3748,
    address: '花蓮縣瑞穗鄉中山路一段17號',
    category: 'MEDICAL',
    aliases: ['瑞穗衛生所'],
    taigiAliases: [],
    priority: 4, district: '瑞穗鄉'
  },
  {
    name: '慈濟大學附設醫院',
    lat: 24.0181, lng: 121.5972,
    address: '花蓮縣花蓮市建國路一段112號',
    category: 'MEDICAL',
    aliases: ['慈大附院', '慈濟附院', '建國路醫院'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },

  // ================================================
  // 學校（11 筆）
  // ================================================
  {
    name: '國立東華大學',
    lat: 23.9135, lng: 121.5499,
    address: '花蓮縣壽豐鄉大學路二段1號',
    category: 'SCHOOL',
    aliases: ['東華', '東華大學', '東大', '壽豐大學'],
    taigiAliases: [],
    priority: 8, district: '壽豐鄉'
  },
  {
    name: '慈濟大學',
    lat: 24.0187, lng: 121.5971,
    address: '花蓮縣花蓮市中央路三段701號',
    category: 'SCHOOL',
    aliases: ['慈大', '慈濟大學'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '慈濟科技大學',
    lat: 24.0161, lng: 121.5938,
    address: '花蓮縣花蓮市建國路二段880號',
    category: 'SCHOOL',
    aliases: ['慈科大', '慈濟科大', '慈濟護專'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '國立花蓮高級中學',
    lat: 23.9893, lng: 121.6044,
    address: '花蓮縣花蓮市府前路1號',
    category: 'SCHOOL',
    aliases: ['花中', '花蓮高中', '花蓮高級中學', '府前路學校'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '國立花蓮女子高級中學',
    lat: 23.9876, lng: 121.6072,
    address: '花蓮縣花蓮市民國路90號',
    category: 'SCHOOL',
    aliases: ['花女', '花蓮女中', '花女高中'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '國立花蓮高級農業職業學校',
    lat: 24.0032, lng: 121.6087,
    address: '花蓮縣花蓮市農校路22號',
    category: 'SCHOOL',
    aliases: ['花農', '花蓮農校', '農校'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '國立花蓮高級工業職業學校',
    lat: 23.9937, lng: 121.6085,
    address: '花蓮縣花蓮市中山路916號',
    category: 'SCHOOL',
    aliases: ['花工', '花蓮工校', '工校', '工業學校'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '花蓮縣立花蓮國民中學',
    lat: 23.9896, lng: 121.6012,
    address: '花蓮縣花蓮市中正路50號',
    category: 'SCHOOL',
    aliases: ['花蓮國中', '花中國中'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },
  {
    name: '花蓮縣立吉安國民中學',
    lat: 23.9677, lng: 121.5879,
    address: '花蓮縣吉安鄉吉安村吉安路一段100號',
    category: 'SCHOOL',
    aliases: ['吉安國中'],
    taigiAliases: [],
    priority: 4, district: '吉安鄉'
  },
  {
    name: '花蓮縣立中正國民小學',
    lat: 23.9875, lng: 121.6025,
    address: '花蓮縣花蓮市中正路69號',
    category: 'SCHOOL',
    aliases: ['中正國小', '花蓮中正國小'],
    taigiAliases: [],
    priority: 4, district: '花蓮市'
  },
  {
    name: '花蓮縣立明義國民小學',
    lat: 23.9801, lng: 121.6079,
    address: '花蓮縣花蓮市明義街30號',
    category: 'SCHOOL',
    aliases: ['明義國小', '明義後門'],
    taigiAliases: [],
    priority: 4, district: '花蓮市'
  },
  {
    name: '四維高級中學',
    lat: 23.9850, lng: 121.6050,
    address: '花蓮縣花蓮市中山路717號',
    category: 'SCHOOL',
    aliases: ['四維', '四維高中', '四維中學'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },

  // ================================================
  // 商業（12 筆）
  // ================================================
  {
    name: '東大門夜市',
    lat: 23.9777, lng: 121.6079,
    address: '花蓮縣花蓮市中華路一段',
    category: 'COMMERCIAL',
    aliases: ['東大門', '夜市', '花蓮夜市', '中華路夜市'],
    taigiAliases: ['暗市仔', '夜市仔'],
    priority: 9, district: '花蓮市'
  },
  {
    name: '遠東百貨花蓮店',
    lat: 23.9770, lng: 121.6087,
    address: '花蓮縣花蓮市中山路356號',
    category: 'COMMERCIAL',
    aliases: ['遠百', '遠東', '遠東百貨', '百貨公司', '遠百花蓮'],
    taigiAliases: [],
    priority: 8, district: '花蓮市'
  },
  {
    name: '家樂福花蓮店',
    lat: 24.0025, lng: 121.6118,
    address: '花蓮縣花蓮市國盛二街188號',
    category: 'COMMERCIAL',
    aliases: ['家樂福', '花蓮家樂福'],
    taigiAliases: [],
    priority: 8, district: '花蓮市'
  },
  {
    name: '好市多花蓮店',
    lat: 24.0221, lng: 121.6173,
    address: '花蓮縣花蓮市嘉里路一段188號',
    category: 'COMMERCIAL',
    aliases: ['好市多', 'Costco', '花蓮好市多', 'costco'],
    taigiAliases: [],
    priority: 8, district: '花蓮市'
  },
  {
    name: '大潤發花蓮店',
    lat: 23.9889, lng: 121.6120,
    address: '花蓮縣花蓮市國聯一路80號',
    category: 'COMMERCIAL',
    aliases: ['大潤發', '花蓮大潤發', 'RT-Mart'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '全聯花蓮中山店',
    lat: 23.9820, lng: 121.6063,
    address: '花蓮縣花蓮市中山路一段',
    category: 'COMMERCIAL',
    aliases: ['全聯', '全聯超市'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '花蓮文化創意產業園區',
    lat: 23.9760, lng: 121.6120,
    address: '花蓮縣花蓮市中華路144號',
    category: 'COMMERCIAL',
    aliases: ['文創園區', '花蓮文創', '酒廠文創', '文化創意園區'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '花蓮市公有零售市場',
    lat: 23.9800, lng: 121.6070,
    address: '花蓮縣花蓮市中正路622號',
    category: 'COMMERCIAL',
    aliases: ['花蓮市場', '菜市場', '菜市仔', '中央市場', '公有市場'],
    taigiAliases: ['菜市仔', '菜市場'],
    priority: 7, district: '花蓮市'
  },
  {
    name: '新光三越花蓮遠雄廣場',
    lat: 24.0142, lng: 121.6103,
    address: '花蓮縣花蓮市文苑路',
    category: 'COMMERCIAL',
    aliases: ['新光三越', '遠雄廣場', '花蓮廣場'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '丁丁連鎖藥局花蓮店',
    lat: 23.9830, lng: 121.6070,
    address: '花蓮縣花蓮市中山路553號',
    category: 'COMMERCIAL',
    aliases: ['丁丁', '丁丁藥局', '花蓮丁丁'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '丁丁連鎖藥局吉安店',
    lat: 23.9700, lng: 121.5870,
    address: '花蓮縣吉安鄉中華路二段11號',
    category: 'COMMERCIAL',
    aliases: ['吉安丁丁', '丁丁吉安'],
    taigiAliases: [],
    priority: 5, district: '吉安鄉'
  },
  {
    name: '公正包子店',
    lat: 23.9780, lng: 121.6050,
    address: '花蓮縣花蓮市仁愛街46號',
    category: 'COMMERCIAL',
    aliases: ['公正包子', '包子店', '公正街包子'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '中華電信花蓮服務中心',
    lat: 23.9780, lng: 121.6080,
    address: '花蓮縣花蓮市中正路595號',
    category: 'COMMERCIAL',
    aliases: ['中華電信', '電信局', '花蓮中華電信', '中正路中華電信'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '好樂迪KTV花蓮店',
    lat: 24.0005, lng: 121.6130,
    address: '花蓮縣花蓮市國聯五路69號',
    category: 'COMMERCIAL',
    aliases: ['好樂迪', 'KTV', '花蓮KTV', '好樂迪KTV', '唱歌'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '三角形餐酒館',
    lat: 23.9770, lng: 121.6055,
    address: '花蓮縣花蓮市光復街52號',
    category: 'COMMERCIAL',
    aliases: ['三角形', '三角型', '三角形pub', '三角型pub', 'Triangle Bar'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },

  // ================================================
  // 政府（10 筆）
  // ================================================
  {
    name: '花蓮縣政府',
    lat: 23.9906, lng: 121.6078,
    address: '花蓮縣花蓮市府前路17號',
    category: 'GOVERNMENT',
    aliases: ['縣政府', '花蓮縣府', '府前路縣府'],
    taigiAliases: [],
    priority: 8, district: '花蓮市'
  },
  {
    name: '花蓮市公所',
    lat: 23.9848, lng: 121.6086,
    address: '花蓮縣花蓮市博愛街121號',
    category: 'GOVERNMENT',
    aliases: ['市公所', '花蓮市公所', '博愛街公所'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '吉安鄉公所',
    lat: 23.9716, lng: 121.5872,
    address: '花蓮縣吉安鄉吉安村吉安路二段169號',
    category: 'GOVERNMENT',
    aliases: ['吉安公所', '吉安鄉公所'],
    taigiAliases: [],
    priority: 5, district: '吉安鄉'
  },
  {
    name: '新城鄉公所',
    lat: 24.1260, lng: 121.6567,
    address: '花蓮縣新城鄉新城村博愛路11號',
    category: 'GOVERNMENT',
    aliases: ['新城公所', '新城鄉公所'],
    taigiAliases: [],
    priority: 5, district: '新城鄉'
  },
  {
    name: '壽豐鄉公所',
    lat: 23.8574, lng: 121.5299,
    address: '花蓮縣壽豐鄉壽豐路一段109號',
    category: 'GOVERNMENT',
    aliases: ['壽豐公所', '壽豐鄉公所'],
    taigiAliases: [],
    priority: 5, district: '壽豐鄉'
  },
  {
    name: '花蓮地方法院',
    lat: 23.9936, lng: 121.6082,
    address: '花蓮縣花蓮市中正路291號',
    category: 'GOVERNMENT',
    aliases: ['法院', '地方法院', '花蓮法院'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '花蓮監理站',
    lat: 24.0043, lng: 121.6101,
    address: '花蓮縣花蓮市國聯一路23號',
    category: 'GOVERNMENT',
    aliases: ['監理站', '監理所', '花蓮監理'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '花蓮郵局',
    lat: 23.9985, lng: 121.6112,
    address: '花蓮縣花蓮市中山路315號',
    category: 'GOVERNMENT',
    aliases: ['郵局', '花蓮總郵局', '中山路郵局'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },
  {
    name: '花蓮稅務局',
    lat: 23.9889, lng: 121.6059,
    address: '花蓮縣花蓮市中山路31號',
    category: 'GOVERNMENT',
    aliases: ['稅務局', '國稅局', '花蓮國稅局'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },
  {
    name: '花蓮縣警察局',
    lat: 23.9921, lng: 121.6082,
    address: '花蓮縣花蓮市府前路12號',
    category: 'GOVERNMENT',
    aliases: ['警察局', '警局', '花蓮警局', '派出所'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },

  // ================================================
  // 景點（13 筆）
  // ================================================
  {
    name: '太魯閣國家公園遊客中心',
    lat: 24.1586, lng: 121.6191,
    address: '花蓮縣秀林鄉崇德村富世291號',
    category: 'ATTRACTION',
    aliases: ['太魯閣', '太魯閣公園', '太魯閣遊客中心', '太魯閣牌樓'],
    taigiAliases: [],
    priority: 10, district: '秀林鄉'
  },
  {
    name: '七星潭風景區',
    lat: 24.0488, lng: 121.6394,
    address: '花蓮縣新城鄉七星街',
    category: 'ATTRACTION',
    aliases: ['七星潭', '七星潭海灘', '七星潭風景區'],
    taigiAliases: [],
    priority: 9, district: '新城鄉'
  },
  {
    name: '鯉魚潭風景區',
    lat: 23.8988, lng: 121.5651,
    address: '花蓮縣壽豐鄉池南路一段',
    category: 'ATTRACTION',
    aliases: ['鯉魚潭', '鯉魚潭水庫'],
    taigiAliases: [],
    priority: 8, district: '壽豐鄉'
  },
  {
    name: '南濱公園',
    lat: 23.9721, lng: 121.6163,
    address: '花蓮縣花蓮市南濱路一段',
    category: 'ATTRACTION',
    aliases: ['南濱', '南濱海岸', '南濱夜市'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '北濱公園',
    lat: 23.9924, lng: 121.6256,
    address: '花蓮縣花蓮市海濱路',
    category: 'ATTRACTION',
    aliases: ['北濱', '北濱海岸', '北濱海灘'],
    taigiAliases: [],
    priority: 7, district: '花蓮市'
  },
  {
    name: '松園別館',
    lat: 23.9914, lng: 121.6241,
    address: '花蓮縣花蓮市松園街65號',
    category: 'ATTRACTION',
    aliases: ['松園', '松園別墅', '花蓮松園'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '花蓮糖廠',
    lat: 23.9791, lng: 121.5828,
    address: '花蓮縣吉安鄉糖廠路',
    category: 'ATTRACTION',
    aliases: ['糖廠', '吉安糖廠', '花蓮糖廠冰淇淋'],
    taigiAliases: [],
    priority: 7, district: '吉安鄉'
  },
  {
    name: '瑞穗溫泉',
    lat: 23.4941, lng: 121.3636,
    address: '花蓮縣瑞穗鄉溫泉路',
    category: 'ATTRACTION',
    aliases: ['瑞穗溫泉', '瑞穗泡湯'],
    taigiAliases: [],
    priority: 6, district: '瑞穗鄉'
  },
  {
    name: '玉里溫泉',
    lat: 23.3340, lng: 121.2981,
    address: '花蓮縣玉里鎮溫泉街',
    category: 'ATTRACTION',
    aliases: ['玉里溫泉', '玉里泡湯'],
    taigiAliases: [],
    priority: 5, district: '玉里鎮'
  },
  {
    name: '吉安慶修院',
    lat: 23.9665, lng: 121.5872,
    address: '花蓮縣吉安鄉中興路345巷16號',
    category: 'ATTRACTION',
    aliases: ['慶修院', '吉安慶修院', '日式神社'],
    taigiAliases: [],
    priority: 6, district: '吉安鄉'
  },
  {
    name: '花蓮石雕博物館',
    lat: 23.9935, lng: 121.6244,
    address: '花蓮縣花蓮市海岸路81號',
    category: 'ATTRACTION',
    aliases: ['石雕博物館', '花蓮博物館'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },
  {
    name: '花蓮縣文化局',
    lat: 23.9891, lng: 121.5997,
    address: '花蓮縣花蓮市文復路6號',
    category: 'ATTRACTION',
    aliases: ['文化局', '花蓮文化局', '文化中心'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },
  {
    name: '美崙山公園',
    lat: 23.9960, lng: 121.6156,
    address: '花蓮縣花蓮市美崙山',
    category: 'ATTRACTION',
    aliases: ['美崙山', '美崙公園', '美崙'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },

  // ================================================
  // 飯店（10 筆）
  // ================================================
  {
    name: '翰品酒店花蓮',
    lat: 24.0012, lng: 121.6126,
    address: '花蓮縣花蓮市國聯一路86號',
    category: 'HOTEL',
    aliases: ['翰品酒店', '翰品', '花蓮翰品'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '統帥大飯店',
    lat: 23.9844, lng: 121.6207,
    address: '花蓮縣花蓮市中美路6號',
    category: 'HOTEL',
    aliases: ['統帥', '統帥飯店', '統帥大飯店'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '美崙大飯店',
    lat: 23.9942, lng: 121.6235,
    address: '花蓮縣花蓮市林森路3號',
    category: 'HOTEL',
    aliases: ['美崙飯店', '美崙大飯店', '花蓮美崙'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '理想大地渡假村',
    lat: 23.8580, lng: 121.5259,
    address: '花蓮縣壽豐鄉理想路1號',
    category: 'HOTEL',
    aliases: ['理想大地', '理想大地飯店', '壽豐理想大地'],
    taigiAliases: [],
    priority: 7, district: '壽豐鄉'
  },
  {
    name: '煙波大飯店花蓮館',
    lat: 23.9801, lng: 121.6110,
    address: '花蓮縣花蓮市中山路五段1號',
    category: 'HOTEL',
    aliases: ['煙波', '煙波飯店', '花蓮煙波'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '福容大飯店花蓮',
    lat: 24.0010, lng: 121.6138,
    address: '花蓮縣花蓮市國聯一路2號',
    category: 'HOTEL',
    aliases: ['福容', '福容飯店', '花蓮福容'],
    taigiAliases: [],
    priority: 6, district: '花蓮市'
  },
  {
    name: '遠雄悅來大飯店',
    lat: 24.0234, lng: 121.5823,
    address: '花蓮縣壽豐鄉遠雄路1號',
    category: 'HOTEL',
    aliases: ['遠雄悅來', '遠雄飯店', '悅來'],
    taigiAliases: [],
    priority: 6, district: '壽豐鄉'
  },
  {
    name: '馥麗溫泉大飯店',
    lat: 24.1381, lng: 121.6568,
    address: '花蓮縣新城鄉嘉里路一段',
    category: 'HOTEL',
    aliases: ['馥麗', '馥麗溫泉', '花蓮馥麗'],
    taigiAliases: [],
    priority: 5, district: '新城鄉'
  },
  {
    name: '花蓮亞士都飯店',
    lat: 23.9862, lng: 121.6189,
    address: '花蓮縣花蓮市海濱路23號',
    category: 'HOTEL',
    aliases: ['亞士都', '亞士都飯店'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },
  {
    name: '花蓮假期大飯店',
    lat: 23.9887, lng: 121.6088,
    address: '花蓮縣花蓮市中正路440號',
    category: 'HOTEL',
    aliases: ['假期大飯店', '花蓮假期', '花蓮假期飯店'],
    taigiAliases: [],
    priority: 5, district: '花蓮市'
  },

  // ================================================
  // 鄉鎮（13 筆）- 花蓮縣全部 13 鄉鎮市
  // ================================================
  {
    name: '花蓮市',
    lat: 23.9871, lng: 121.6015,
    address: '花蓮縣花蓮市',
    category: 'TOWNSHIP',
    aliases: ['花蓮市', '花蓮市區', '花蓮縣花蓮市'],
    taigiAliases: [],
    priority: 3, district: '花蓮市'
  },
  {
    name: '花蓮縣吉安鄉',
    lat: 23.9716, lng: 121.5869,
    address: '花蓮縣吉安鄉',
    category: 'TOWNSHIP',
    aliases: ['吉安', '吉安鄉'],
    taigiAliases: [],
    priority: 5, district: '吉安鄉'
  },
  {
    name: '花蓮縣新城鄉',
    lat: 24.1273, lng: 121.6549,
    address: '花蓮縣新城鄉',
    category: 'TOWNSHIP',
    aliases: ['新城', '新城鄉', '嘉里'],
    taigiAliases: [],
    priority: 5, district: '新城鄉'
  },
  {
    name: '花蓮縣壽豐鄉',
    lat: 23.8574, lng: 121.5274,
    address: '花蓮縣壽豐鄉',
    category: 'TOWNSHIP',
    aliases: ['壽豐', '壽豐鄉'],
    taigiAliases: [],
    priority: 4, district: '壽豐鄉'
  },
  {
    name: '花蓮縣光復鄉',
    lat: 23.6726, lng: 121.4421,
    address: '花蓮縣光復鄉',
    category: 'TOWNSHIP',
    aliases: ['光復', '光復鄉'],
    taigiAliases: [],
    priority: 4, district: '光復鄉'
  },
  {
    name: '花蓮縣豐濱鄉',
    lat: 23.6238, lng: 121.4887,
    address: '花蓮縣豐濱鄉',
    category: 'TOWNSHIP',
    aliases: ['豐濱', '豐濱鄉'],
    taigiAliases: [],
    priority: 3, district: '豐濱鄉'
  },
  {
    name: '花蓮縣瑞穗鄉',
    lat: 23.5000, lng: 121.3741,
    address: '花蓮縣瑞穗鄉',
    category: 'TOWNSHIP',
    aliases: ['瑞穗', '瑞穗鄉'],
    taigiAliases: [],
    priority: 4, district: '瑞穗鄉'
  },
  {
    name: '花蓮縣富里鄉',
    lat: 23.2000, lng: 121.2706,
    address: '花蓮縣富里鄉',
    category: 'TOWNSHIP',
    aliases: ['富里', '富里鄉'],
    taigiAliases: [],
    priority: 3, district: '富里鄉'
  },
  {
    name: '花蓮縣秀林鄉',
    lat: 24.1531, lng: 121.5990,
    address: '花蓮縣秀林鄉',
    category: 'TOWNSHIP',
    aliases: ['秀林', '秀林鄉'],
    taigiAliases: [],
    priority: 4, district: '秀林鄉'
  },
  {
    name: '花蓮縣萬榮鄉',
    lat: 23.7474, lng: 121.3915,
    address: '花蓮縣萬榮鄉',
    category: 'TOWNSHIP',
    aliases: ['萬榮', '萬榮鄉'],
    taigiAliases: [],
    priority: 3, district: '萬榮鄉'
  },
  {
    name: '花蓮縣卓溪鄉',
    lat: 23.3910, lng: 121.2249,
    address: '花蓮縣卓溪鄉',
    category: 'TOWNSHIP',
    aliases: ['卓溪', '卓溪鄉'],
    taigiAliases: [],
    priority: 3, district: '卓溪鄉'
  },
  {
    name: '花蓮縣玉里鎮',
    lat: 23.3368, lng: 121.3097,
    address: '花蓮縣玉里鎮',
    category: 'TOWNSHIP',
    aliases: ['玉里', '玉里鎮'],
    taigiAliases: [],
    priority: 5, district: '玉里鎮'
  },
  {
    name: '花蓮縣鳳林鎮',
    lat: 23.7436, lng: 121.4497,
    address: '花蓮縣鳳林鎮',
    category: 'TOWNSHIP',
    aliases: ['鳳林', '鳳林鎮'],
    taigiAliases: [],
    priority: 4, district: '鳳林鎮'
  },
];

// ========== HualienAddressDB Class ==========

class HualienAddressDB {
  // 預建索引：key → LandmarkEntry（O(1) 查詢）
  private exactIndex: Map<string, LandmarkEntry> = new Map();
  private aliasIndex: Map<string, LandmarkEntry> = new Map();
  private taigiIndex: Map<string, LandmarkEntry> = new Map();

  constructor() {
    this.buildIndex();
  }

  private buildIndex(): void {
    for (const entry of LANDMARKS) {
      // 正式全名
      this.exactIndex.set(entry.name, entry);
      // aliases
      for (const alias of entry.aliases) {
        if (!this.aliasIndex.has(alias)) {
          this.aliasIndex.set(alias, entry);
        } else {
          // 優先保留 priority 較高的
          const existing = this.aliasIndex.get(alias)!;
          if (entry.priority > existing.priority) {
            this.aliasIndex.set(alias, entry);
          }
        }
      }
      // taigiAliases
      for (const alias of entry.taigiAliases) {
        if (!this.taigiIndex.has(alias)) {
          this.taigiIndex.set(alias, entry);
        }
      }
    }
    console.log(`[HualienAddressDB] 已建立索引：${LANDMARKS.length} 筆地標，` +
      `${this.aliasIndex.size} 個別名，${this.taigiIndex.size} 個台語別名`);
  }

  /**
   * 主查詢：精確名稱 → 別名 → 台語別名 → 子字串包含
   */
  lookup(input: string): LookupResult | null {
    if (!input) return null;
    const normalized = input.trim();

    // ① 精確全名
    const exact = this.exactIndex.get(normalized);
    if (exact) {
      return { entry: exact, matchedAlias: normalized, matchType: 'EXACT', confidence: 1.0 };
    }

    // ② 精確別名
    const alias = this.aliasIndex.get(normalized);
    if (alias) {
      return { entry: alias, matchedAlias: normalized, matchType: 'ALIAS', confidence: 0.95 };
    }

    // ③ 台語別名
    const taigi = this.taigiIndex.get(normalized);
    if (taigi) {
      console.log(`[HualienAddressDB] 台語命中: ${normalized} → ${taigi.name}`);
      return { entry: taigi, matchedAlias: normalized, matchType: 'TAIGI', confidence: 0.85 };
    }

    // ④ 子字串掃描（input 包含別名，或別名包含 input）
    let bestMatch: LookupResult | null = null;
    let bestPriority = -1;

    for (const [key, entry] of this.exactIndex) {
      if (normalized.includes(key) || key.includes(normalized)) {
        if (entry.priority > bestPriority) {
          bestPriority = entry.priority;
          bestMatch = { entry, matchedAlias: key, matchType: 'SUBSTRING', confidence: 0.75 };
        }
      }
    }
    for (const [key, entry] of this.aliasIndex) {
      if (normalized.includes(key) || key.includes(normalized)) {
        if (entry.priority > bestPriority) {
          bestPriority = entry.priority;
          bestMatch = { entry, matchedAlias: key, matchType: 'SUBSTRING', confidence: 0.75 };
        }
      }
    }
    for (const [key, entry] of this.taigiIndex) {
      if (normalized.includes(key) || key.includes(normalized)) {
        if (entry.priority > bestPriority) {
          bestPriority = entry.priority;
          bestMatch = { entry, matchedAlias: key, matchType: 'TAIGI', confidence: 0.70 };
        }
      }
    }

    if (bestMatch) {
      console.log(`[HualienAddressDB] 子字串命中: ${normalized} → ${bestMatch.entry.name}`);
    }

    return bestMatch;
  }

  /**
   * 把輸入文字中的台語詞 / 別名替換成標準地標名
   * 供 normalizeAddress 呼叫
   */
  resolveAliases(text: string): string {
    let result = text;

    // 台語別名優先替換（因為是最需要修正的）
    for (const [taigi, entry] of this.taigiIndex) {
      if (result.includes(taigi)) {
        result = result.replace(taigi, entry.name);
        console.log(`[HualienAddressDB] 台語替換: ${taigi} → ${entry.name}`);
      }
    }

    // 別名替換
    for (const [alias, entry] of this.aliasIndex) {
      if (result.includes(alias) && !result.includes(entry.name)) {
        result = result.replace(alias, entry.name);
      }
    }

    return result;
  }

  /**
   * 直接取得座標（供 geocodeAddress 拿精確座標）
   */
  getCoords(name: string): { lat: number; lng: number; address: string } | null {
    const result = this.lookup(name);
    if (result && result.entry.lat !== null && result.entry.lng !== null) {
      return {
        lat: result.entry.lat,
        lng: result.entry.lng,
        address: result.entry.address
      };
    }
    return null;
  }

  /**
   * 給 Geocoding API 使用的地址前綴（依鄉鎮判斷）
   */
  getGeocodingPrefix(address: string): string {
    const result = this.lookup(address);
    if (result) {
      const district = result.entry.district;
      if (district === '花蓮市') return '花蓮縣花蓮市';
      return `花蓮縣${district}`;
    }
    return '花蓮縣花蓮市';
  }

  /**
   * 取得所有地標（供外部使用）
   */
  getAll(): LandmarkEntry[] {
    return LANDMARKS;
  }
}

export const hualienAddressDB = new HualienAddressDB();
