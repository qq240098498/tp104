const { load, LEVELS, STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型决定，先做类型匹配再做行匹配
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 文件所属目录取完整的上级目录（src/web/legacy/old-util.js 归到 src/web/legacy）；
// 直接放在根目录下的文件归到“根目录”
function directoryOf(filePath) {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '根目录' : filePath.slice(0, slash);
}

// 文件名是路径最后一段
function fileNameOf(filePath) {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

// 一行是否带了行内豁免标记：js/md 用 // nolint 或 <!-- nolint -->，sh/yml 用行尾或上一行 # nolint
// 不区分大小写、不卡标记后面还写不写别的字
function lineSuppressed(lines, index, fileType) {
  const text = lines[index] || '';
  if (/nolint/i.test(text)) return true;
  if (fileType === 'sh' || fileType === 'yml') {
    const prev = lines[index - 1] || '';
    if (/^\s*#.*nolint/i.test(prev)) return true;
  }
  return false;
}

// 从同一份命中集合折叠出按级别的计数；三个级别全部给键，保证前端拿到的分布是完整的
function tallyByLevel(levelCounter) {
  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  Object.keys(levelCounter).forEach((key) => { byLevel[key] += levelCounter[key]; });
  return byLevel;
}

// 扫描：启用的规则逐条去比对范围内的文件，命中记到具体行上；带 nolint 的行记为忽略
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

  // 所有命中先收进同一份清单（含有效与忽略），后面各种汇总都从它折叠，口径天然一致
  const allHits = [];
  const ignoredHits = [];
  const scopedFiles = scopeFile ? [scopeFile] : data.files;
  const applicable = data.rules.filter((item) => item.status === STATUSES[0]
    && (!scopeRule || item.id === scopeRule.id)
    && (!level || item.level === level));

  applicable.forEach((rule) => {
    scopedFiles.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      const lines = file.content.split('\n');
      lines.forEach((text, index) => {
        if (!text.includes(rule.pattern)) return;
        const hit = {
          ruleId: rule.id,
          code: rule.code,
          ruleName: rule.name,
          level: rule.level,
          pattern: rule.pattern,
          fileId: file.id,
          path: file.path,
          fileType: file.type,
          directory: directoryOf(file.path),
          lineNo: index + 1,
          lineText: text.trim(),
          ignored: false,
        };
        allHits.push(hit);
        if (lineSuppressed(lines, index, file.type)) {
          hit.ignored = true;
          ignoredHits.push(hit);
        }
      });
    });
  });

  allHits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const validHits = allHits.filter((hit) => !hit.ignored);

  // ---- 全局按级别（只算有效命中）----
  const globalLevelCounter = {};
  validHits.forEach((hit) => { globalLevelCounter[hit.level] = (globalLevelCounter[hit.level] || 0) + 1; });

  // ---- 全局按规则/按文件（只算有效命中）----
  const byRuleMap = new Map();
  const byFileMap = new Map();
  validHits.forEach((hit) => {
    if (!byRuleMap.has(hit.code)) {
      byRuleMap.set(hit.code, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(hit.code).count += 1;

    if (!byFileMap.has(hit.path)) {
      byFileMap.set(hit.path, {
        path: hit.path,
        fileType: hit.fileType,
        directory: hit.directory,
        count: 0,
      });
    }
    byFileMap.get(hit.path).count += 1;
  });

  // ---- 按目录 → 文件 → 每类规则（只算有效命中），忽略条目在每一级单另计数 ----
  const dirMap = new Map();
  validHits.forEach((hit) => {
    if (!dirMap.has(hit.directory)) {
      dirMap.set(hit.directory, {
        directory: hit.directory,
        count: 0,
        files: new Map(),
        levelCounter: {},
      });
    }
    const dir = dirMap.get(hit.directory);
    dir.count += 1;
    dir.levelCounter[hit.level] = (dir.levelCounter[hit.level] || 0) + 1;

    if (!dir.files.has(hit.path)) {
      dir.files.set(hit.path, {
        path: hit.path,
        name: fileNameOf(hit.path),
        fileType: hit.fileType,
        count: 0,
        byRule: new Map(),
        levelCounter: {},
      });
    }
    const fileAgg = dir.files.get(hit.path);
    fileAgg.count += 1;
    fileAgg.levelCounter[hit.level] = (fileAgg.levelCounter[hit.level] || 0) + 1;

    if (!fileAgg.byRule.has(hit.code)) {
      fileAgg.byRule.set(hit.code, {
        code: hit.code,
        ruleName: hit.ruleName,
        level: hit.level,
        count: 0,
      });
    }
    fileAgg.byRule.get(hit.code).count += 1;
  });

  // 忽略条目按 目录 → 文件 → 规则 记计数，保证“目录忽略数 = 其下各文件忽略数之和”
  const ignoredByPathMap = new Map();
  ignoredHits.forEach((hit) => {
    if (!ignoredByPathMap.has(hit.path)) {
      ignoredByPathMap.set(hit.path, {
        path: hit.path,
        directory: directoryOf(hit.path),
        fileType: hit.fileType,
        count: 0,
        levelCounter: {},
        ruleMap: new Map(),
      });
    }
    const entry = ignoredByPathMap.get(hit.path);
    entry.count += 1;
    entry.levelCounter[hit.level] = (entry.levelCounter[hit.level] || 0) + 1;
    if (!entry.ruleMap.has(hit.code)) {
      entry.ruleMap.set(hit.code, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    entry.ruleMap.get(hit.code).count += 1;
  });

  // 把忽略数挂到对应目录与文件上；没有有效命中但有忽略条目的目录/文件也要进汇总
  const ensureDir = (directory) => {
    if (!dirMap.has(directory)) {
      dirMap.set(directory, {
        directory,
        count: 0,
        files: new Map(),
        levelCounter: {},
      });
    }
    return dirMap.get(directory);
  };
  const ensureFile = (dir, hit) => {
    if (!dir.files.has(hit.path)) {
      dir.files.set(hit.path, {
        path: hit.path,
        name: fileNameOf(hit.path),
        fileType: hit.fileType,
        count: 0,
        byRule: new Map(),
        levelCounter: {},
      });
    }
    return dir.files.get(hit.path);
  };

  ignoredByPathMap.forEach((entry) => {
    const dir = ensureDir(entry.directory);
    const fileAgg = ensureFile(dir, { path: entry.path, fileType: entry.fileType });
    dir.ignored = (dir.ignored || 0) + entry.count;
    fileAgg.ignored = (fileAgg.ignored || 0) + entry.count;
    fileAgg.ignoredByLevel = tallyByLevel(entry.levelCounter);
    fileAgg.ignoredByRule = Array.from(entry.ruleMap.values())
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  });

  // 目录汇总落成普通数组，每一级都给出完整的三档级别分布与可直接对账的数字
  const byDirectory = Array.from(dirMap.values()).map((dir) => {
    const files = Array.from(dir.files.values()).map((fileAgg) => ({
      path: fileAgg.path,
      name: fileAgg.name,
      fileType: fileAgg.fileType,
      count: fileAgg.count,
      ignored: fileAgg.ignored || 0,
      byLevel: tallyByLevel(fileAgg.levelCounter),
      byRule: Array.from(fileAgg.byRule.values())
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
      ignoredByLevel: fileAgg.ignoredByLevel || tallyByLevel({}),
      ignoredByRule: fileAgg.ignoredByRule || [],
    })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      directory: dir.directory,
      count: dir.count,
      ignored: dir.ignored || 0,
      files,
      fileCount: files.filter((item) => item.count > 0).length,
      byLevel: tallyByLevel(dir.levelCounter),
    };
  }).sort((a, b) => (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));

  // 全局忽略按级别分布
  const ignoredLevelCounter = {};
  ignoredHits.forEach((hit) => {
    ignoredLevelCounter[hit.level] = (ignoredLevelCounter[hit.level] || 0) + 1;
  });

  return {
    scannedAt: new Date().toISOString(),
    enabledRules: data.rules.filter((item) => item.status === STATUSES[0]).length,
    rulesUsed: applicable.length,
    filesInScope: scopedFiles.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning: scopeRule && scopeRule.status !== STATUSES[0]
      ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对`
      : '',
    hits: validHits,
    ignoredHits,
    summary: {
      total: validHits.length,
      ignoredTotal: ignoredHits.length,
      byLevel: tallyByLevel(globalLevelCounter),
      ignoredByLevel: tallyByLevel(ignoredLevelCounter),
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
      byDirectory,
    },
  };
}

module.exports = { scan, ruleAppliesToFile, levelOrder, directoryOf, lineSuppressed };
