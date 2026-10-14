// A small word list the Thesaurus falls back on when Puter's AI cannot be
// reached: common words of business and teaching slides. Each entry lists
// synonyms and, where there is a natural one, antonyms.
const W = (synonyms, antonyms = []) => ({ synonyms, antonyms });

export const OFFLINE_THESAURUS = {
  achieve: W(
    ["accomplish", "attain", "reach", "realize", "deliver"],
    ["fail", "miss"],
  ),
  bad: W(
    ["poor", "weak", "inferior", "faulty", "unfavorable"],
    ["good", "excellent"],
  ),
  begin: W(
    ["start", "launch", "open", "initiate", "kick off"],
    ["end", "finish"],
  ),
  benefit: W(
    ["advantage", "gain", "value", "upside", "reward"],
    ["drawback", "cost"],
  ),
  big: W(
    ["large", "major", "substantial", "sizable", "considerable"],
    ["small", "minor"],
  ),
  build: W(
    ["create", "construct", "develop", "assemble", "form"],
    ["dismantle", "demolish"],
  ),
  change: W(
    ["shift", "adjust", "modify", "revise", "transform"],
    ["keep", "maintain"],
  ),
  clear: W(
    ["plain", "obvious", "evident", "explicit", "transparent"],
    ["unclear", "vague"],
  ),
  complex: W(
    ["complicated", "intricate", "involved", "elaborate", "detailed"],
    ["simple", "straightforward"],
  ),
  create: W(
    ["make", "produce", "design", "build", "generate"],
    ["destroy", "remove"],
  ),
  customer: W(["client", "buyer", "user", "patron", "consumer"]),
  decrease: W(
    ["reduce", "lower", "cut", "decline", "shrink"],
    ["increase", "raise"],
  ),
  difficult: W(
    ["hard", "challenging", "demanding", "tough", "complex"],
    ["easy", "simple"],
  ),
  easy: W(
    ["simple", "straightforward", "effortless", "painless", "smooth"],
    ["difficult", "hard"],
  ),
  effective: W(
    ["successful", "productive", "powerful", "efficient", "useful"],
    ["ineffective", "useless"],
  ),
  efficient: W(
    ["productive", "streamlined", "economical", "effective", "lean"],
    ["wasteful", "inefficient"],
  ),
  end: W(
    ["finish", "close", "conclusion", "completion", "finale"],
    ["start", "beginning"],
  ),
  fast: W(["quick", "rapid", "swift", "speedy", "brisk"], ["slow", "gradual"]),
  few: W(
    ["several", "a handful of", "some", "limited", "scant"],
    ["many", "numerous"],
  ),
  finish: W(
    ["complete", "end", "conclude", "wrap up", "finalize"],
    ["start", "begin"],
  ),
  goal: W(["aim", "objective", "target", "purpose", "intention"]),
  good: W(
    ["great", "fine", "excellent", "positive", "favorable"],
    ["bad", "poor"],
  ),
  great: W(
    ["excellent", "outstanding", "superb", "remarkable", "terrific"],
    ["poor", "mediocre"],
  ),
  grow: W(
    ["expand", "increase", "develop", "scale", "rise"],
    ["shrink", "decline"],
  ),
  happy: W(
    ["glad", "pleased", "delighted", "content", "cheerful"],
    ["sad", "unhappy"],
  ),
  help: W(
    ["assist", "support", "aid", "guide", "enable"],
    ["hinder", "obstruct"],
  ),
  idea: W(["concept", "notion", "thought", "proposal", "suggestion"]),
  important: W(
    ["key", "significant", "essential", "critical", "vital"],
    ["minor", "trivial"],
  ),
  improve: W(
    ["enhance", "better", "upgrade", "strengthen", "refine"],
    ["worsen", "weaken"],
  ),
  increase: W(
    ["raise", "grow", "boost", "expand", "lift"],
    ["decrease", "reduce"],
  ),
  key: W(
    ["main", "central", "crucial", "essential", "principal"],
    ["minor", "secondary"],
  ),
  main: W(
    ["primary", "chief", "principal", "leading", "central"],
    ["secondary", "minor"],
  ),
  major: W(
    ["significant", "main", "important", "large", "serious"],
    ["minor", "small"],
  ),
  make: W(["create", "produce", "build", "form", "generate"]),
  many: W(
    ["numerous", "several", "multiple", "countless", "plenty of"],
    ["few", "little"],
  ),
  minor: W(
    ["small", "slight", "secondary", "lesser", "trivial"],
    ["major", "significant"],
  ),
  new: W(["fresh", "novel", "recent", "modern", "latest"], ["old", "outdated"]),
  old: W(["former", "previous", "dated", "aged", "earlier"], ["new", "recent"]),
  opportunity: W(
    ["chance", "opening", "prospect", "possibility", "occasion"],
    ["threat", "obstacle"],
  ),
  plan: W(["strategy", "scheme", "approach", "roadmap", "program"]),
  problem: W(
    ["issue", "difficulty", "challenge", "obstacle", "concern"],
    ["solution", "answer"],
  ),
  quick: W(
    ["fast", "rapid", "speedy", "prompt", "swift"],
    ["slow", "sluggish"],
  ),
  result: W(
    ["outcome", "effect", "consequence", "finding", "product"],
    ["cause", "source"],
  ),
  risk: W(
    ["danger", "threat", "hazard", "exposure", "uncertainty"],
    ["safety", "certainty"],
  ),
  sad: W(
    ["unhappy", "sorrowful", "downcast", "gloomy", "dejected"],
    ["happy", "glad"],
  ),
  show: W(
    ["display", "present", "demonstrate", "reveal", "illustrate"],
    ["hide", "conceal"],
  ),
  significant: W(
    ["important", "notable", "considerable", "meaningful", "substantial"],
    ["insignificant", "minor"],
  ),
  simple: W(
    ["easy", "plain", "basic", "straightforward", "uncomplicated"],
    ["complex", "complicated"],
  ),
  slow: W(
    ["gradual", "unhurried", "leisurely", "sluggish", "steady"],
    ["fast", "quick"],
  ),
  small: W(
    ["little", "minor", "compact", "modest", "slight"],
    ["big", "large"],
  ),
  start: W(
    ["begin", "launch", "open", "commence", "initiate"],
    ["end", "stop"],
  ),
  strong: W(
    ["powerful", "robust", "solid", "sturdy", "firm"],
    ["weak", "fragile"],
  ),
  support: W(
    ["help", "back", "assist", "aid", "sustain"],
    ["oppose", "undermine"],
  ),
  team: W(["group", "crew", "squad", "unit", "staff"]),
  use: W(["apply", "employ", "utilize", "adopt", "operate"]),
  weak: W(
    ["frail", "feeble", "fragile", "poor", "limited"],
    ["strong", "powerful"],
  ),
};

export function offlineLookup(word) {
  const key = String(word || "")
    .trim()
    .toLowerCase();
  const hit = OFFLINE_THESAURUS[key];
  if (!hit) return null;
  return {
    word: key,
    meanings: [{ sense: "", synonyms: hit.synonyms, antonyms: hit.antonyms }],
  };
}
