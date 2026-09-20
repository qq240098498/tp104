const { load, LEVELS, STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 路径没有目录段的文件归到“（根目录）”，让汇总里每一条都能落进某个目录
const ROOT_DIR = '（根目录）';
function dirOf(filePath) {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? ROOT_DIR : filePath.slice(0, index);
}

// 新建一个各级别都为 0 的分布桶
function emptyLevelCounts() {
  const counts = {};
  LEVELS.forEach((item) => { counts[item] = 0; });
  return counts;
}

// 单条匹配（命中或被忽略）落进清单时共用的字段
function makeEntry(rule, file, index, text, ignored, reason) {
  return {
    ruleId: rule.id,
    code: rule.code,
    ruleName: rule.name,
    level: rule.level,
    status: rule.status,
    pattern: rule.pattern,
    fileId: file.id,
    path: file.path,
    dir: dirOf(file.path),
    fileType: file.type,
    lineNo: index + 1,
    lineText: text.trim(),
    ignored,
    reason: reason || '',
  };
}

// 给文件级别的类别桶加一条；桶按规则编码现用现建，不留空类别
function bumpCategory(list, entry) {
  let cat = list.find((item) => item.code === entry.code);
  if (!cat) {
    cat = { code: entry.code, ruleName: entry.ruleName, level: entry.level, count: 0 };
    list.push(cat);
  }
  cat.count += 1;
}

// 把命中清单单源聚合成“目录 → 文件 → 类别”的汇总。
// 目录下各文件条数之和等于目录条数，目录之间相加等于总数，
// 级别分布之和、类别之和同样等于总数——因为都是从同一份清单数出来的。
function aggregate(hits, ignored) {
  const dirMap = new Map();

  function ensureDir(entry) {
    let dir = dirMap.get(entry.dir);
    if (!dir) {
      dir = {
        dir: entry.dir,
        count: 0,
        fileCount: 0,
        ignored: 0,
        byLevel: emptyLevelCounts(),
        files: [],
      };
      dirMap.set(entry.dir, dir);
    }
    return dir;
  }

  function ensureFile(dirEntry, entry) {
    let file = dirEntry.files.find((item) => item.fileId === entry.fileId);
    if (!file) {
      file = {
        fileId: entry.fileId,
        path: entry.path,
        fileType: entry.fileType,
        count: 0,
        ignored: 0,
        byLevel: emptyLevelCounts(),
        byCategory: [],
        ignoredCategories: [],
      };
      dirEntry.files.push(file);
    }
    return file;
  }

  // 有效命中：目录与文件的 count、涉及文件数、级别分布、类别分布一起累加
  hits.forEach((entry) => {
    const dir = ensureDir(entry);
    const file = ensureFile(dir, entry);
    dir.count += 1;
    file.count += 1;
    dir.byLevel[entry.level] += 1;
    file.byLevel[entry.level] += 1;
    bumpCategory(file.byCategory, entry);
  });

  // 被忽略的匹配只进 ignored 口径，绝不算进有效命中
  ignored.forEach((entry) => {
    const dir = ensureDir(entry);
    const file = ensureFile(dir, entry);
    dir.ignored += 1;
    file.ignored += 1;
    bumpCategory(file.ignoredCategories, entry);
  });

  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  return Array.from(dirMap.values()).map((dir) => {
    dir.files.sort(byPath);
    // 涉及文件数只数有有效命中的文件；只有被忽略匹配的文件不算进来
    dir.fileCount = dir.files.filter((file) => file.count > 0).length;
    dir.files.forEach((file) => {
      file.byCategory.sort(byCode);
      file.ignoredCategories.sort(byCode);
    });
    return dir;
  }).sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上；
// 停用规则在范围内的匹配单独记成“被忽略”，不混进有效命中
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const data = load();

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUSES[0]);
  const disabled = data.rules.filter((item) => item.status !== STATUSES[0]);
  const warning = scopeRule && scopeRule.status !== STATUSES[0]
    ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对，它在范围里的匹配记在被忽略里`
    : '';

  const levelMatches = (rule) => !level || rule.level === level;
  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter(levelMatches);

  // 被忽略的口径：整轮扫描时统计全部停用规则；只扫一条停用时只统计那一条。
  // 级别筛选对有效命中和被忽略同样生效，两边口径才能对得上。
  const ignoredSource = scopeRule
    ? (scopeRule.status !== STATUSES[0] ? [scopeRule] : [])
    : disabled;
  const rulesRecordedIgnored = ignoredSource.filter(levelMatches);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  function matchRule(rule, isIgnored, reason) {
    const entries = [];
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          entries.push(makeEntry(rule, file, index, text, isIgnored, reason));
        }
      });
    });
    return entries;
  }

  const hits = [];
  rulesUsed.forEach((rule) => {
    hits.push(...matchRule(rule, false, ''));
  });

  const ignored = [];
  rulesRecordedIgnored.forEach((rule) => {
    ignored.push(...matchRule(rule, true, '规则已停用'));
  });

  const sortEntries = (a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  };
  hits.sort(sortEntries);
  ignored.sort(sortEntries);

  const byLevel = emptyLevelCounts();
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const ignoredByLevel = emptyLevelCounts();
  ignored.forEach((item) => { ignoredByLevel[item.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    if (!byRuleMap.has(hit.code)) {
      byRuleMap.set(hit.code, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(hit.code).count += 1;
  });

  return {
    scannedAt: new Date().toISOString(),
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    rulesRecordedIgnored: rulesRecordedIgnored.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    ignored,
    summary: {
      total: hits.length,
      byLevel,
      ignoredTotal: ignored.length,
      ignoredByLevel,
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byDirectory: aggregate(hits, ignored),
    },
  };
}

module.exports = { scan, ruleAppliesToFile, levelOrder, dirOf, ROOT_DIR };
