import { pinyin } from "pinyin-pro";
import type { SourceLanguage, TermKind } from "@rpgtl/contracts";

/** A name with its English and kind, before it is a glossary term. */
export interface NamedTerm {
  readonly source: string;
  readonly translation: string;
  readonly kind: TermKind;
}

const singleSurnames =
  "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅厐熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁锺徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石钮崔吉鉏龚程嵇邢滑裴陆荣翁荀於羊惠甄麹家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷虙车侯宓蓬全郗班仰秋仲伊宫甯仇栾暴甘针厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴鬱胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通冀边扈燕翼郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆厍师巩库聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公晋楚闫法汝鄢涂钦岳帅缑亢郈况有琴佘佴墨哈谯笪年爱阳佟言福钟庞";

const compoundSurnames =
  "万俟 司马 上官 欧阳 夏侯 诸葛 闻人 东方 赫连 皇甫 尉迟 公羊 澹台 公冶 宗政 濮阳 淳于 单于 太叔 申屠 公孙 仲孙 轩辕 令狐 钟离 宇文 长孙 慕容 鲜于 闾丘 司徒 司空 亓官 司寇 仉督 子车 颛孙 端木 巫马 公西 漆雕 乐正 壤驷 公良 拓跋 夹谷 宰父 谷梁 段干 百里 东郭 南门 呼延 归海 羊舌 微生 梁丘 左丘 东门 西门 商牟 伯赏 南宫 第五".split(
    " ",
  );

const han = /^\p{Script=Han}+$/u;
const surnameSet = new Set(singleSurnames);
const compoundSurnameSet = new Set(compoundSurnames);

function editDistance(a: string, b: string) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? 0;
      previous[j] =
        a[i - 1] === b[j - 1] ? diagonal : 1 + Math.min(diagonal, above, previous[j - 1] ?? 0);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

function pinyinSyllables(source: string) {
  return pinyin(source, { toneType: "none", type: "array", mode: "surname", v: true });
}

const hangul = /^\p{Script=Hangul}+$/u;
const initials = "g kk n d tt r m b pp s ss - j jj ch k t p h".split(" ");
const vowels = "a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i".split(" ");
const finals = "- k k k n n n t l k m l l l p l m p p t t ng t t k t p t".split(" ");
const letters = (romanized: string | undefined) => (romanized === "-" ? "" : (romanized ?? ""));

/**
 * Hangul in Revised Romanization syllable by syllable, without the sound changes between them,
 * which is near enough to tell whether English sounds like it.
 */
function romanizedHangul(source: string) {
  return Array.from(source, (syllable) => {
    const code = (syllable.codePointAt(0) ?? 0) - 0xac00;
    if (code < 0 || code > 11_171) return "";
    return (
      letters(initials[Math.floor(code / 588)]) +
      letters(vowels[Math.floor((code % 588) / 28)]) +
      letters(finals[code % 28])
    );
  }).join("");
}

/** How much English sounds like the source written in Latin letters, from 0 to 1. */
function soundSimilarity(source: string, english: string, language: SourceLanguage) {
  const romanized =
    language === "chinese" && han.test(source)
      ? pinyinSyllables(source).join("")
      : language === "korean" && hangul.test(source)
        ? romanizedHangul(source)
        : undefined;
  if (romanized === undefined) return undefined;
  const a = english.toLowerCase().replace(/[^a-z]/g, "");
  if (!a && !romanized) return 1;
  return 1 - editDistance(a, romanized) / Math.max(a.length, romanized.length);
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function familyName(source: string) {
  if (source.length >= 2 && compoundSurnameSet.has(source.slice(0, 2))) return 2;
  if (surnameSet.has(source.charAt(0))) return 1;
  return undefined;
}

function familyPinyin(source: string, size: number) {
  const syllables = pinyinSyllables(source);
  const family = syllables.slice(0, size).join("");
  const given = syllables.slice(size).join("");
  return given ? `${capitalize(family)} ${capitalize(given)}` : capitalize(family);
}

/**
 * A new glossary term. Actors and speakers start as characters, and English that sounds like the
 * source as a name, until the model sorts the term. Chinese names close to their pinyin are
 * spelled in it. Korean ones are kept as given: Korean games also write Japanese names in Hangul
 * (하루키 is Haruki), which a rule for Korean family names would split wrongly (Ha Ruki).
 */
export function nameTerm(
  source: string,
  english: string,
  fromOrigin: boolean,
  language: SourceLanguage,
): NamedTerm {
  const similarity = soundSimilarity(source, english, language);
  const kind = fromOrigin
    ? "character"
    : similarity !== undefined && similarity >= 0.6
      ? "name"
      : "word";
  if (language !== "chinese") return { source, translation: english, kind };
  // A given name without a family name is one word in pinyin: "Xing Lan" → "Xinglan".
  if (similarity === 1 && /\s/.test(english) && familyName(source) === undefined)
    return { source, translation: capitalize(english.replace(/\s+/g, "").toLowerCase()), kind };
  const translation =
    similarity !== undefined &&
    similarity >= 0.6 &&
    similarity < 1 &&
    source.length >= 2 &&
    source.length <= 3
      ? (() => {
          const family = familyName(source);
          return family === undefined ? english : familyPinyin(source, family);
        })()
      : english;
  return { source, translation, kind };
}
