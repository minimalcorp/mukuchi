import { getPattern } from "isbot";
import { LOCALE_PATHS, type Locale } from "./locales";

/** 言語の切り替えで選んだ言語 (閲覧者のブラウザだけに残る。消えていればブラウザの言語で決め直すだけ) */
const LOCALE_CHOICE_KEY = "mukuchi.lp.locale";

/** 言語の切り替えのリンクを押した時に呼ぶ。選んだ日本語を `/` の自動の移動で英語へ戻さないため */
export function rememberLocaleChoice(locale: Locale) {
  try {
    window.localStorage.setItem(LOCALE_CHOICE_KEY, locale);
  } catch {
    // 保存できなくても、サイト内からの移動は referrer で見分けるので選んだ言語のまま開ける
  }
}

const botPattern = getPattern();

/**
 * `/` (日本語) をブラウザの第一言語が日本語以外で開いた時に `/en/` へ移す (<head> のインライン script)。
 * 描画の前に移し、日本語のページを一瞬見せない。移さないのは次の時:
 * - 言語の切り替えで日本語を選んだ (localStorage) か、サイト内から来た (referrer が同じ origin。保存できない時の代わり)
 * - クローラー (isbot。Googlebot は英語の navigator.language で JS を実行するため、移すと日本語のページを索引できない)
 * - 言語を取れない
 * クエリ・ハッシュ (utm_* など) は引き継ぐ
 */
export const LOCALE_REDIRECT_SCRIPT = `(function(){
if(location.pathname!=="/")return;
var c=null;try{c=localStorage.getItem(${JSON.stringify(LOCALE_CHOICE_KEY)});}catch(e){}
if(c==="ja")return;
if(c!=="en"){
try{if(document.referrer&&new URL(document.referrer).origin===location.origin)return;}catch(e){}
if(new RegExp(${JSON.stringify(botPattern.source)},${JSON.stringify(botPattern.flags)}).test(navigator.userAgent))return;
var l=((navigator.languages&&navigator.languages[0])||navigator.language||"").toLowerCase();
if(l===""||l==="ja"||l.indexOf("ja-")===0)return;
}
location.replace(${JSON.stringify(LOCALE_PATHS.en)}+location.search+location.hash);
})();`;
