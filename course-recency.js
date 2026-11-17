(function (root) {
  'use strict';

  const cache = new Map();
  const prefix = 'quizlab.course-recency.v1.';

  function entries(workspace) {
    const key = prefix + workspace;
    if (!cache.has(key)) {
      let value = {};
      try {
        const saved = JSON.parse(root.localStorage.getItem(key) || '{}');
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) value = saved;
      } catch {}
      cache.set(key, value);
    }
    return cache.get(key);
  }

  function touch(workspace, courseId) {
    if (!workspace || !courseId) return;
    const value = { ...entries(workspace), [courseId]: Date.now() };
    const recent = Object.fromEntries(Object.entries(value)
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 300));
    cache.set(prefix + workspace, recent);
    try { root.localStorage.setItem(prefix + workspace, JSON.stringify(recent)); } catch {}
  }

  function activityAt(workspace, courseId, course = {}) {
    let latest = Number(entries(workspace)[courseId]) || 0;
    for (const event of [...(course.attempts || []), ...(course.exams || [])]) {
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) latest = Math.max(latest, at);
    }
    return latest;
  }

  root.addEventListener?.('storage', event => {
    if (event.key === null) cache.clear();
    else if (event.key.startsWith(prefix)) cache.delete(event.key);
  });

  root.QuizLabCourseRecency = { touch, activityAt };
})(globalThis);
