/**
 * 方块/物品/实体/群系的中文名。
 *
 * 这里只列两类词:整词表收不规则的与常见的,词素表收前缀(材质/颜色/木种)与
 * 后缀(器物类别),其余靠组合拼出来。minecraft-data 只带 en_us,中文得自己给;
 * 游戏 ID 采用组合命名(acacia_log = 金合欢 + 原木)，因此只枚举不规则整词。
 * 无法组合的名称返回原始 ID，表示中文词表未覆盖。
 */
import { isRealId, type NameRegistry } from './chests.ts';

/**
 * 组合生成的中文名附带注册表校验；不存在的 id 在名称后保留原始 id。
 * 未安装注册表时仅返回组合名。
 */
let nameRegistry: NameRegistry | null = null;

/**
 * 连上服务端后装一次;传 null 卸掉。
 * 两张表都没有的对象等于没装:判据答不出「这是不是真 id」时一个字都不加,不装作知道。
 */
export function setNameRegistry(reg: NameRegistry | null | undefined): void {
  nameRegistry = reg?.itemsByName || reg?.blocksByName ? reg : null;
}

/** 拼出来的名字:registry 里查无此 id 就把 id 摆出来,别让假 id 看着像真的 */
function stampUnknownId(id: string, zh: string): string {
  if (nameRegistry === null || isRealId(nameRegistry, id)) return zh;
  return `${zh}(${id},原版里没有这个 id)`;
}

/** 不规则或常用到值得单列的整词 */
const WHOLE: Record<string, string> = {
  // 地形与自然
  dirt: '泥土', coarse_dirt: '砂土', rooted_dirt: '缠根泥土', podzol: '灰化土',
  grass_block: '草方块', mycelium: '菌丝', farmland: '耕地', dirt_path: '土径',
  sand: '沙子', red_sand: '红沙', gravel: '沙砾', clay: '黏土', clay_ball: '黏土球',
  stone: '石头', cobblestone: '圆石', deepslate: '深板岩', cobbled_deepslate: '深板岩圆石',
  granite: '花岗岩', diorite: '闪长岩', andesite: '安山岩', calcite: '方解石', tuff: '凝灰岩',
  sandstone: '砂岩', red_sandstone: '红砂岩', obsidian: '黑曜石', bedrock: '基岩',
  netherrack: '下界岩', soul_sand: '灵魂沙', soul_soil: '灵魂土', magma_block: '岩浆块',
  basalt: '玄武岩', blackstone: '黑石', end_stone: '末地石', ancient_debris: '远古残骸',
  water: '水', lava: '岩浆', ice: '冰', packed_ice: '浮冰', blue_ice: '蓝冰',
  snow: '雪', snow_block: '雪块', powder_snow: '细雪',
  // 矿石(组合拼出来会丢官方叫法,单列)
  coal_ore: '煤矿石', iron_ore: '铁矿石', copper_ore: '铜矿石', gold_ore: '金矿石',
  diamond_ore: '钻石矿石', emerald_ore: '绿宝石矿石', lapis_ore: '青金石矿石',
  redstone_ore: '红石矿石', nether_quartz_ore: '下界石英矿石', nether_gold_ore: '下界金矿石',
  // 植物
  cactus: '仙人掌', sugar_cane: '甘蔗', bamboo: '竹子', vine: '藤蔓', cobweb: '蜘蛛网',
  kelp: '海带', kelp_plant: '海带', seagrass: '海草', tall_seagrass: '高海草',
  dead_bush: '枯萎的灌木', short_grass: '草', tall_grass: '高草丛', fern: '蕨',
  poppy: '虞美人', dandelion: '蒲公英', sunflower: '向日葵', torchflower: '火把花',
  lily_pad: '睡莲', moss_block: '苔藓块', glow_lichen: '发光地衣',
  blue_orchid: '兰花', allium: '绒球葱', azure_bluet: '蓝花美耳草', oxeye_daisy: '滨菊',
  cornflower: '矢车菊', wither_rose: '凋灵玫瑰', lily_of_the_valley: '铃兰',
  red_tulip: '红色郁金香', orange_tulip: '橙色郁金香', white_tulip: '白色郁金香',
  pink_tulip: '粉红色郁金香', pink_petals: '粉红色花簇', spore_blossom: '孢子花',
  mud: '泥巴', dripstone_block: '滴水石块', crimson_nylium: '绯红菌岩',
  warped_nylium: '诡异菌岩', budding_amethyst: '紫水晶母岩', heavy_core: '重型核心',
  air: '空气', fire: '火', soul_fire: '灵魂火', redstone_wire: '红石线',
  iron_bars: '铁栏杆', chain: '锁链', hay_block: '干草捆', carved_pumpkin: '雕刻南瓜',
  jack_o_lantern: '南瓜灯', packed_mud: '泥坯', prismarine: '海晶石',
  dark_prismarine: '暗海晶石', sea_pickle: '海泡菜', azalea: '杜鹃花丛',
  flowering_azalea: '盛开的杜鹃花丛', moss_carpet: '苔藓地毯', hanging_roots: '垂根',
  sculk: '幽匿块', end_rod: '末地烛', chorus_plant: '紫颂植株', chorus_flower: '紫颂花',
  chorus_fruit: '紫颂果', lightning_rod: '避雷针', honey_block: '蜜块', target: '标靶',
  lilac: '丁香', rose_bush: '玫瑰丛', peony: '牡丹', carrots: '胡萝卜作物',
  potatoes: '马铃薯作物', dragon_egg: '龙蛋', weeping_vines: '垂泪藤',
  twisting_vines: '缠怨藤', smooth_quartz: '平滑石英块', nether_portal: '下界传送门',
  tripwire: '绊线', tripwire_hook: '绊线钩', flower_pot: '花盆', cocoa: '可可',
  barrier: '屏障', light: '光源方块', pitcher_plant: '瓶子草', structure_void: '结构空位',
  wet_sponge: '湿海绵', mossy_cobblestone: '苔石圆石', piston_head: '活塞头',
  moving_piston: '移动中的活塞', chiseled_bookshelf: '錾制书架',
  // 功能方块
  crafting_table: '工作台', furnace: '熔炉', blast_furnace: '高炉', smoker: '烟熏炉',
  chest: '箱子', ender_chest: '末影箱', barrel: '木桶', hopper: '漏斗',
  torch: '火把', soul_torch: '灵魂火把', lantern: '灯笼', soul_lantern: '灵魂灯笼',
  campfire: '营火', glowstone: '荧石', sea_lantern: '海晶灯', redstone_lamp: '红石灯',
  enchanting_table: '附魔台', anvil: '铁砧', brewing_stand: '酿造台', cauldron: '炼药锅',
  bookshelf: '书架', beacon: '信标', conduit: '潮涌核心', respawn_anchor: '重生锚',
  smithing_table: '锻造台', stonecutter: '切石机', grindstone: '砂轮', loom: '织布机',
  cartography_table: '制图台', fletching_table: '制箭台', composter: '堆肥桶',
  lectern: '讲台', bell: '钟', jukebox: '唱片机', note_block: '音符盒',
  dispenser: '发射器', dropper: '投掷器', observer: '侦测器', piston: '活塞',
  sticky_piston: '粘性活塞', lever: '拉杆', repeater: '红石中继器', comparator: '红石比较器',
  ladder: '梯子', scaffolding: '脚手架', rail: '铁轨', tnt: '炸药', spawner: '刷怪笼',
  // 材料
  stick: '木棍', string: '线', bone: '骨头', bone_meal: '骨粉', feather: '羽毛',
  flint: '燧石', gunpowder: '火药', leather: '皮革', paper: '纸', book: '书',
  charcoal: '木炭', raw_iron: '粗铁', raw_gold: '粗金', raw_copper: '粗铜',
  redstone: '红石粉', glowstone_dust: '荧石粉', blaze_rod: '烈焰棒', blaze_powder: '烈焰粉',
  ender_pearl: '末影珍珠', ender_eye: '末影之眼', ghast_tear: '恶魂之泪',
  nether_star: '下界之星', nether_wart: '下界疣', slime_ball: '黏液球',
  honeycomb: '蜜脾', sponge: '海绵', rotten_flesh: '腐肉', spider_eye: '蜘蛛眼',
  // 食物
  apple: '苹果', golden_apple: '金苹果', bread: '面包', wheat: '小麦', wheat_seeds: '小麦种子',
  carrot: '胡萝卜', golden_carrot: '金胡萝卜', potato: '马铃薯', baked_potato: '烤马铃薯',
  poisonous_potato: '毒马铃薯', beetroot: '甜菜根', beetroot_seeds: '甜菜种子',
  melon: '西瓜', melon_slice: '西瓜片', pumpkin: '南瓜', pumpkin_pie: '南瓜派',
  sweet_berries: '甜浆果', glow_berries: '发光浆果', cookie: '曲奇', cake: '蛋糕',
  beef: '生牛肉', cooked_beef: '牛排', porkchop: '生猪排', cooked_porkchop: '熟猪排',
  chicken: '生鸡肉', cooked_chicken: '熟鸡肉', mutton: '生羊肉', cooked_mutton: '熟羊肉',
  rabbit: '生兔肉', cooked_rabbit: '熟兔肉', cod: '生鳕鱼', cooked_cod: '熟鳕鱼',
  salmon: '生鲑鱼', cooked_salmon: '熟鲑鱼', tropical_fish: '热带鱼', pufferfish: '河豚',
  milk_bucket: '牛奶桶', mushroom_stew: '蘑菇煲', rabbit_stew: '兔肉煲', suspicious_stew: '谜之炖菜',
  // 器物
  bow: '弓', crossbow: '弩', arrow: '箭', shield: '盾牌', trident: '三叉戟',
  fishing_rod: '钓鱼竿', flint_and_steel: '打火石', shears: '剪刀', bucket: '桶',
  water_bucket: '水桶', lava_bucket: '岩浆桶', compass: '指南针', clock: '钟表',
  map: '地图', spyglass: '望远镜', saddle: '鞍', name_tag: '命名牌', lead: '拴绳',
  elytra: '鞘翅', totem_of_undying: '不死图腾', turtle_helmet: '海龟壳',
  egg: '鸡蛋', snowball: '雪球', experience_bottle: '附魔之瓶',
  bowl: '碗', sugar: '糖', ink_sac: '墨囊', glow_ink_sac: '荧光墨囊', cocoa_beans: '可可豆',
  glass_bottle: '玻璃瓶', potion: '药水', splash_potion: '喷溅药水',
  lingering_potion: '滞留药水', tipped_arrow: '药箭', dragon_breath: '龙息',
  magma_cream: '岩浆膏', fermented_spider_eye: '发酵蜘蛛眼', netherite_scrap: '下界合金碎片',
  netherite_upgrade_smithing_template: '下界合金升级锻造模板',
  rabbit_foot: '兔子脚', rabbit_hide: '兔子皮', shulker_shell: '潜影壳',
  enchanted_book: '附魔书', written_book: '成书', writable_book: '书与笔', filled_map: '地图',
  dried_kelp: '干海带', dried_kelp_block: '干海带块', beetroot_soup: '甜菜汤',
  enchanted_golden_apple: '附魔金苹果', carrot_on_a_stick: '胡萝卜钓竿',
  turtle_scute: '海龟鳞甲', armadillo_scute: '犰狳鳞甲', wolf_armor: '狼铠', mace: '重锤',
  recovery_compass: '追溯指南针', bundle: '收纳袋', firework_star: '烟花之星',
  fire_charge: '火焰弹', popped_chorus_fruit: '爆裂紫颂果', knowledge_book: '知识之书',
  crafter: '合成器', bee_nest: '蜂巢', beehive: '蜂箱', crying_obsidian: '哭泣的黑曜石',
  lodestone: '磁石', gilded_blackstone: '镀金黑石', shroomlight: '菌光体',
  frogspawn: '蛙卵', pointed_dripstone: '滴水石锥', bubble_column: '气泡柱',
  cave_air: '空气', void_air: '空气', sweet_berry_bush: '甜浆果丛',
  beetroots: '甜菜作物', frosted_ice: '霜冰', daylight_detector: '阳光探测器',
  end_portal_frame: '末地传送门框架', end_gateway: '末地折跃门',
  glistering_melon_slice: '闪烁的西瓜片', painting: '画', bamboo_raft: '竹筏',
  bamboo_chest_raft: '竹运输筏', cave_vines: '洞穴藤蔓', cave_vines_plant: '洞穴藤蔓',
  big_dripleaf: '大型垂滴叶', small_dripleaf: '小型垂滴叶', item_frame: '物品展示框',
  glow_item_frame: '荧光物品展示框', armor_stand: '盔甲架', end_crystal: '末影水晶',
  firework_rocket: '烟花火箭', structure_block: '结构方块', jigsaw: '拼图方块',
  phantom_membrane: '幻翼膜', nautilus_shell: '鹦鹉螺壳', heart_of_the_sea: '海洋之心',
  honey_bottle: '蜂蜜瓶', goat_horn: '山羊角', echo_shard: '回响碎片', brush: '刷子',
  spectral_arrow: '光灵箭', wind_charge: '风弹', dragon_head: '龙首',
  trial_spawner: '试炼刷怪笼', vault: '宝库', ochre_froglight: '赭黄蛙明灯',
  verdant_froglight: '青翠蛙明灯', pearlescent_froglight: '珠光蛙明灯',
  small_amethyst_bud: '小型紫晶芽', medium_amethyst_bud: '中型紫晶芽',
  large_amethyst_bud: '大型紫晶芽',
};

/** 前缀词素:木种、材质、颜色 */
const MODIFIER: Record<string, string> = {
  oak: '橡木', spruce: '云杉', birch: '白桦', jungle: '丛林', acacia: '金合欢',
  dark_oak: '深色橡木', mangrove: '红树', cherry: '樱花', bamboo: '竹', pale_oak: '苍白橡木',
  crimson: '绯红', warped: '诡异', nether: '下界', end: '末地',
  stone: '石', cobblestone: '圆石', deepslate: '深板岩', cobbled_deepslate: '深板岩圆石',
  granite: '花岗岩', diorite: '闪长岩', andesite: '安山岩', sandstone: '砂岩',
  red_sandstone: '红砂岩', blackstone: '黑石', basalt: '玄武岩', quartz: '石英',
  purpur: '紫珀', prismarine: '海晶石', obsidian: '黑曜石', mud: '泥',
  iron: '铁', gold: '金', golden: '金', diamond: '钻石', netherite: '下界合金',
  copper: '铜', coal: '煤炭', lapis: '青金石', lapis_lazuli: '青金石', redstone: '红石',
  emerald: '绿宝石', amethyst: '紫水晶', wooden: '木', leather: '皮革', chainmail: '锁链',
  turtle: '海龟', raw_iron: '粗铁', raw_gold: '粗金', raw_copper: '粗铜',
  white: '白色', orange: '橙色', magenta: '品红色', light_blue: '淡蓝色',
  yellow: '黄色', lime: '黄绿色', pink: '粉红色', gray: '灰色', light_gray: '淡灰色',
  cyan: '青色', purple: '紫色', blue: '蓝色', brown: '棕色', green: '绿色',
  red: '红色', black: '黑色', mossy: '苔石', cracked: '裂纹', chiseled: '錾制',
  polished: '磨制', smooth: '平滑', cut: '切制', waxed: '涂蜡', exposed: '斑驳',
  weathered: '锈蚀', oxidized: '氧化', infested: '被虫蚀的', dead: '失活的',
  stripped: '去皮', muddy: '泥泞', suspicious: '可疑的', flowering: '开花的',
  budding: '紫晶簇生', wet: '湿', powered: '充能', detector: '探测', heavy: '重型',
  large: '大型', small: '小型', tinted: '遮光', reinforced: '强化', ominous: '不祥',
  azalea: '杜鹃', dripstone: '滴水石', pointed: '尖', sculk: '幽匿',
  potted: '盆栽', tube: '管', brain: '脑', bubble: '气泡', horn: '鹿角', fire: '火',
  activator: '激活', trapped: '陷阱', chipped: '开裂', damaged: '破损',
  petrified: '石化', decorated: '饰纹', calibrated: '校频', repeating: '循环',
  chain: '锁链', soul: '灵魂', attached: '附着', carved: '雕刻', packed: '压实',
};

/** 后缀词素:器物类别。长后缀在前,匹配时取最长的一条 */
const BASE: Record<string, string> = {
  armor_trim_smithing_template: '盔甲纹饰锻造模板',
  concrete_powder: '混凝土粉末', glazed_terracotta: '带釉陶瓦',
  stained_glass_pane: '染色玻璃板', stained_glass: '染色玻璃', glass_pane: '玻璃板',
  pressure_plate: '压力板', hanging_sign: '悬挂式告示牌', fence_gate: '栅栏门',
  horse_armor: '马铠', shulker_box: '潜影盒', chest_boat: '运输船', spawn_egg: '刷怪蛋',
  pottery_sherd: '陶片', banner_pattern: '旗帜图案', music_disc: '唱片',
  brick_slab: '砖台阶', brick_stairs: '砖楼梯', brick_wall: '砖墙',
  log: '原木', wood: '木头', planks: '木板', leaves: '树叶', sapling: '树苗',
  stairs: '楼梯', slab: '台阶', fence: '栅栏', door: '门', trapdoor: '活板门',
  button: '按钮', sign: '告示牌', wall: '墙', ore: '矿石', block: '块',
  ingot: '锭', nugget: '粒', bricks: '砖块', brick: '砖', dust: '粉',
  shard: '碎片', seeds: '种子', bucket: '桶', boat: '船', bed: '床',
  wool: '羊毛', carpet: '地毯', concrete: '混凝土', terracotta: '陶瓦', glass: '玻璃',
  banner: '旗帜', candle: '蜡烛', dye: '染料', minecart: '矿车', pickaxe: '镐',
  sword: '剑', axe: '斧', shovel: '锹', hoe: '锄', helmet: '头盔',
  chestplate: '胸甲', leggings: '护腿', boots: '靴子', pillar: '柱', tiles: '瓦片',
  stem: '菌柄', hyphae: '菌核', roots: '根', fungus: '菌', mushroom: '蘑菇',
  berries: '浆果', sprouts: '芽', vines: '藤', coral: '珊瑚', coral_block: '珊瑚块',
  crystals: '晶簇', cluster: '簇', shulker: '潜影贝', golem: '傀儡',
  froglight: '蛙明灯',
  wall_hanging_sign: '墙上悬挂告示牌', wall_sign: '墙上告示牌', wall_torch: '墙上火把',
  torch: '火把', rail: '铁轨', wire: '线', nylium: '菌岩', propagule: '胎生苗',
  mosaic: '竹马赛克', sponge: '海绵', copper: '铜块', tuff: '凝灰岩', granite: '花岗岩',
  diorite: '闪长岩', andesite: '安山岩', deepslate: '深板岩', sand: '沙子',
  gravel: '沙砾', core: '核', bricks_slab: '砖块台阶', coral_fan: '珊瑚扇', tile: '瓦',
  wall_skull: '墙上头颅', wall_head: '墙上的头', skull: '头颅', head: '头',
  bars: '栏杆', rod: '棒', vein: '脉络', catalyst: '催发体', shrieker: '尖啸体',
  sensor: '感测体', dripleaf: '垂滴叶', pickle: '海泡菜', lantern: '灯笼',
  detector: '探测器', pot: '罐', plant: '植株', flower: '花', fruit: '果',
  egg: '蛋', bush: '丛', cauldron: '炼药锅', portal: '传送门',
  command_block: '命令方块', wart_block: '疣块', bricks_stairs: '砖块楼梯',
};

const BASE_KEYS = Object.keys(BASE).sort((a, b) => b.length - a.length);

const ENTITIES: Record<string, string> = {
  allay: '悦灵', area_effect_cloud: '区域效果云', armadillo: '犰狳', armor_stand: '盔甲架', arrow: '箭', axolotl: '美西螈',
  bat: '蝙蝠', bee: '蜜蜂', blaze: '烈焰人', boat: '船', bogged: '沼骸', breeze: '旋风人',
  camel: '骆驼', cat: '猫', cave_spider: '洞穴蜘蛛', chest_boat: '运输船',
  chest_minecart: '运输矿车', chicken: '鸡', cod: '鳕鱼', cow: '牛', creeper: '苦力怕',
  dolphin: '海豚', donkey: '驴', dragon_fireball: '末影龙火球', drowned: '溺尸',
  egg: '鸡蛋', elder_guardian: '远古守卫者', end_crystal: '末影水晶', ender_dragon: '末影龙',
  ender_pearl: '末影珍珠', enderman: '末影人', endermite: '末影螨', evoker: '唤魔者',
  evoker_fangs: '唤魔者尖牙', experience_bottle: '附魔之瓶', experience_orb: '经验球',
  eye_of_ender: '末影之眼', falling_block: '下落的方块', fireball: '火球',
  firework_rocket: '烟花火箭', fishing_bobber: '浮漂', fox: '狐狸', frog: '青蛙',
  furnace_minecart: '动力矿车', ghast: '恶魂', giant: '巨人', glow_item_frame: '荧光展示框',
  glow_squid: '发光鱿鱼', goat: '山羊', guardian: '守卫者', hoglin: '疣猪兽',
  hopper_minecart: '漏斗矿车', horse: '马', husk: '尸壳', illusioner: '幻术师',
  iron_golem: '铁傀儡', item: '掉落物', item_frame: '物品展示框', leash_knot: '拴绳结',
  lightning_bolt: '闪电', llama: '羊驼', llama_spit: '羊驼唾沫', magma_cube: '岩浆怪',
  minecart: '矿车', mooshroom: '哞菇', mule: '骡', ocelot: '豹猫', painting: '画',
  panda: '熊猫', parrot: '鹦鹉', phantom: '幻翼', pig: '猪', piglin: '猪灵',
  piglin_brute: '猪灵蛮兵', pillager: '掠夺者', polar_bear: '北极熊', potion: '药水',
  pufferfish: '河豚', rabbit: '兔子', ravager: '劫掠兽', salmon: '鲑鱼', sheep: '羊',
  shulker: '潜影贝', shulker_bullet: '潜影弹', silverfish: '蠹虫', skeleton: '骷髅',
  skeleton_horse: '骷髅马', slime: '史莱姆', small_fireball: '小火球', sniffer: '嗅探兽',
  snow_golem: '雪傀儡', snowball: '雪球', spectral_arrow: '光灵箭', spider: '蜘蛛',
  squid: '鱿鱼', stray: '流浪者', strider: '炽足兽', tadpole: '蝌蚪', tnt: '炸药',
  tnt_minecart: '炸药矿车', trader_llama: '行商羊驼', trident: '三叉戟',
  tropical_fish: '热带鱼', turtle: '海龟', vex: '恼鬼', villager: '村民',
  vindicator: '卫道士', wandering_trader: '流浪商人', warden: '监守者',
  wind_charge: '风弹', breeze_wind_charge: '风弹', witch: '女巫', wither: '凋灵',
  wither_skeleton: '凋灵骷髅', wither_skull: '凋灵之首', wolf: '狼',
  zoglin: '僵尸疣猪兽', zombie: '僵尸', zombie_horse: '僵尸马',
  zombie_villager: '僵尸村民', zombified_piglin: '僵尸猪灵', player: '玩家',
};

const BIOMES: Record<string, string> = {
  badlands: '恶地', bamboo_jungle: '竹林', basalt_deltas: '玄武岩三角洲', beach: '沙滩',
  birch_forest: '桦木森林', cherry_grove: '樱花树林', cold_ocean: '冷水海洋',
  crimson_forest: '绯红森林', dark_forest: '黑森林', deep_cold_ocean: '冷水深海',
  deep_dark: '深暗之域', deep_frozen_ocean: '封冻深海', deep_lukewarm_ocean: '温水深海',
  deep_ocean: '深海', desert: '沙漠', dripstone_caves: '溶洞', end_barrens: '末地荒地',
  end_highlands: '末地高地', end_midlands: '末地内陆', eroded_badlands: '风蚀恶地',
  flower_forest: '繁花森林', forest: '森林', frozen_ocean: '封冻海洋',
  frozen_peaks: '冰封山峰', frozen_river: '冻河', grove: '雪林', ice_spikes: '冰刺之地',
  jagged_peaks: '尖峭山峰', jungle: '丛林', lukewarm_ocean: '温水海洋',
  lush_caves: '繁茂洞穴', mangrove_swamp: '红树林沼泽', meadow: '草甸',
  mushroom_fields: '蘑菇岛', nether_wastes: '下界荒地', ocean: '海洋',
  old_growth_birch_forest: '原始桦木森林', old_growth_pine_taiga: '原始松木针叶林',
  old_growth_spruce_taiga: '原始云杉针叶林', plains: '平原', river: '河流',
  savanna: '热带草原', savanna_plateau: '热带高原', small_end_islands: '末地小型岛屿',
  snowy_beach: '积雪沙滩', snowy_plains: '雪原', snowy_slopes: '积雪山坡',
  snowy_taiga: '积雪针叶林', soul_sand_valley: '灵魂沙峡谷', sparse_jungle: '稀疏丛林',
  stony_peaks: '裸岩山峰', stony_shore: '石岸', sunflower_plains: '向日葵平原',
  swamp: '沼泽', taiga: '针叶林', the_end: '末地', the_void: '虚空',
  warm_ocean: '暖水海洋', warped_forest: '诡异森林', windswept_forest: '风袭森林',
  windswept_gravelly_hills: '风袭沙砾丘陵', windswept_hills: '风袭丘陵',
  windswept_savanna: '风袭热带草原', wooded_badlands: '疏林恶地', unknown: '还没看清的地方',
};

const DIMENSIONS: Record<string, string> = {
  overworld: '主世界', the_nether: '下界', nether: '下界', the_end: '末地',
};

const MODIFIER_KEYS = Object.keys(MODIFIER).sort((a, b) => b.length - a.length);

/**
 * 方块/物品的中文名。整词表优先,拼不出整词就递归拆(先按最长后缀切出类别,
 * 再按最长前缀切出修饰词),两个方向都会继续下探:`deepslate_iron_ore` 拆两层
 * (深板岩 + 铁矿石),`waxed_exposed_cut_copper` 拆四层。
 */
export function zhName(id: string, depth = 0): string {
  const name = id.replace(/^minecraft:/, '');
  const whole = WHOLE[name];
  if (whole) return whole;
  if (depth > 4) return name;
  for (const base of BASE_KEYS) {
    if (name === base) return BASE[base];
    if (!name.endsWith(`_${base}`)) continue;
    const head = name.slice(0, -(base.length + 1));
    const mod = MODIFIER[head] ?? WHOLE[head] ?? ENTITIES[head] ?? zhTranslated(head, depth + 1);
    // 拼出来的整词只在最外层核 id:递归里的分段(`deepslate` / `cobblestone`)
    // 本来就是词素不是 id,拿去问 registry 会把真名也判成假
    if (mod) return depth === 0 ? stampUnknownId(name, `${mod}${BASE[base]}`) : `${mod}${BASE[base]}`;
  }
  for (const key of MODIFIER_KEYS) {
    if (!name.startsWith(`${key}_`)) continue;
    const rest = zhTranslated(name.slice(key.length + 1), depth + 1);
    if (rest) {
      return depth === 0 ? stampUnknownId(name, `${MODIFIER[key]}${rest}`) : `${MODIFIER[key]}${rest}`;
    }
  }
  // 材质词单用就是那样东西本身:coal / diamond / emerald 这些既是修饰也是物品
  return MODIFIER[name] ?? name;
}

/** 译得出来才返回,译不出返回 null——递归时用它判断这一支走不走得通 */
function zhTranslated(name: string, depth: number): string | null {
  const zh = zhName(name, depth);
  return /[一-龥]/.test(zh) ? zh : null;
}

export function zhEntity(name: string): string {
  const n = name.replace(/^minecraft:/, '');
  // 实体 id 不在 itemsByName/blocksByName 里,走 depth=1 绕开「这个 id 存不存在」那一问:
  // 那道判据只对物品/方块 id 成立,对实体一律会误报成假
  return ENTITIES[n] ?? zhName(n, 1);
}

/**
 * 村民职业,下标即网络元数据 villagerProfession 的注册表序(1.20.6)。
 * 两点台架实锚:none=0、farmer=5;其余按原版注册表字母序推齐。
 */
export const VILLAGER_PROFESSION_ZH: readonly string[] = [
  '还没有职业', '盔甲匠', '屠夫', '制图师', '牧师', '农民', '渔夫', '制箭师',
  '皮匠', '图书管理员', '石匠', '傻子', '牧羊人', '工具匠', '武器匠',
];

export function zhBiome(name: string): string {
  return BIOMES[name.replace(/^minecraft:/, '')] ?? name;
}

/** 附魔的中文名,键是原版 id */
const ENCHANTS: Record<string, string> = {
  protection: '保护', fire_protection: '火焰保护', feather_falling: '摔落缓冲',
  blast_protection: '爆炸保护', projectile_protection: '弹射物保护', respiration: '水下呼吸',
  aqua_affinity: '水下速掘', thorns: '荆棘', depth_strider: '深海探索者', frost_walker: '冰霜行者',
  binding_curse: '绑定诅咒', soul_speed: '灵魂疾行', swift_sneak: '迅捷潜行',
  sharpness: '锋利', smite: '亡灵杀手', bane_of_arthropods: '节肢杀手', knockback: '击退',
  fire_aspect: '火焰附加', looting: '抢夺', sweeping_edge: '横扫之刃',
  efficiency: '效率', silk_touch: '精准采集', unbreaking: '耐久', fortune: '时运',
  power: '力量', punch: '冲击', flame: '火矢', infinity: '无限',
  luck_of_the_sea: '海之眷顾', lure: '饵钓', loyalty: '忠诚', impaling: '穿刺',
  riptide: '激流', channeling: '引雷', multishot: '多重射击', quick_charge: '快速装填',
  piercing: '穿透', density: '致密', breach: '破甲', wind_burst: '风爆',
  mending: '经验修补', vanishing_curse: '消失诅咒',
};

/** 状态效果的中文名,键是 minecraft-data 的 effect name(驼峰,无下划线) */
const EFFECTS: Record<string, string> = {
  Speed: '迅捷', Slowness: '缓慢', Haste: '急迫', MiningFatigue: '挖掘疲劳', Strength: '力量',
  InstantHealth: '瞬间治疗', InstantDamage: '瞬间伤害', JumpBoost: '跳跃提升', Nausea: '反胃',
  Regeneration: '生命恢复', Resistance: '抗性提升', FireResistance: '抗火',
  WaterBreathing: '水下呼吸', Invisibility: '隐身', Blindness: '失明', NightVision: '夜视',
  Hunger: '饥饿', Weakness: '虚弱', Poison: '中毒', Wither: '凋零', HealthBoost: '生命提升',
  Absorption: '伤害吸收', Saturation: '饱和', Glowing: '发光', Levitation: '飘浮',
  Luck: '幸运', Unluck: '霉运', SlowFalling: '缓降', ConduitPower: '潮涌能量',
  DolphinsGrace: '海豚的恩惠', BadOmen: '不祥之兆', HeroOfTheVillage: '村庄英雄',
  Darkness: '黑暗', TrialOmen: '试炼之兆', RaidOmen: '袭击之兆', WindCharged: '蓄风',
  Weaving: '盘丝', Oozing: '渗浆', Infested: '寄生',
};

export function zhEnchant(name: string): string {
  const n = name.replace(/^minecraft:/, '');
  return ENCHANTS[n] ?? n;
}

export function zhEffect(name: string): string {
  return EFFECTS[name] ?? name;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** 附魔与药水的等级按原版口径写罗马数字;10 以上原版也写不出,照报阿拉伯数字 */
export function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}

export function zhDimension(name: string): string {
  return DIMENSIONS[name.replace(/^minecraft:/, '')] ?? name;
}
