(function () {
    'use strict';

    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatTime(isoStr) {
        if (!isoStr) return '';
        try {
            var d = new Date(isoStr);
            if (isNaN(d.getTime())) return String(isoStr).slice(11, 19) || '';
            var pad = function (n) { return n < 10 ? '0' + n : n; };
            return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        } catch (e) {
            return '';
        }
    }

    var SRC_PALETTE = {
        'user': '#e06c75',
        'devin': '#61afef',
        'agy': '#c678dd',
        'kilo': '#98c379',
        'hermes': '#e5c07b',
        'system': '#5c6370'
    };

    function getSrcColor(src) {
        if (!src) return 'var(--vscode-badge-background, #444)';
        var lower = String(src).toLowerCase();
        if (SRC_PALETTE[lower]) return SRC_PALETTE[lower];
        var hash = 0;
        for (var i = 0; i < src.length; i++) {
            hash = src.charCodeAt(i) + ((hash << 5) - hash);
        }
        var hue = Math.abs(hash) % 360;
        return 'hsl(' + hue + ', 60%, 45%)';
    }

    var MAX_ENTRIES = 200;

    function CommsFeedManager() {
        this.containerEl = null;
        this.entries = [];
        this.customFilter = null;
        this.selectedSrc = 'ALL';
        this.listEl = null;
        this.chipsEl = null;
        this.agentNames = [];
    }

    CommsFeedManager.prototype.mount = function (containerEl) {
        if (!containerEl) return;
        this.containerEl = containerEl;
        this.containerEl.innerHTML = '';

        var root = document.createElement('div');
        root.className = 'comms-feed';

        var header = document.createElement('div');
        header.className = 'comms-feed__header';

        var chips = document.createElement('div');
        chips.className = 'comms-feed__chips';
        header.appendChild(chips);

        var clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'comms-feed__clear';
        clearBtn.textContent = '✕';
        clearBtn.title = 'Purger le flux (.agent/comms.jsonl)';
        var self = this;
        clearBtn.addEventListener('click', function () {
            self.entries = [];
            self.renderChips();
            self.renderList(true);
            if (typeof self.onClearCb === 'function') { self.onClearCb(); }
        });
        header.appendChild(clearBtn);

        var list = document.createElement('div');
        list.className = 'comms-feed__list';

        root.appendChild(header);
        root.appendChild(list);
        this.containerEl.appendChild(root);

        this.chipsEl = chips;
        this.listEl = list;

        this.renderChips();
        this.renderList(true);
    };

    CommsFeedManager.prototype.setEntries = function (entries) {
        var raw = Array.isArray(entries) ? entries : [];
        if (raw.length > MAX_ENTRIES) {
            this.entries = raw.slice(raw.length - MAX_ENTRIES);
        } else {
            this.entries = raw.slice();
        }
        this.renderChips();
        this.renderList(true);
    };

    CommsFeedManager.prototype.appendEntry = function (entry) {
        if (!entry) return;
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
        }
        this.renderChips();
        this.renderList(false);
    };

    CommsFeedManager.prototype.onClear = function (fn) {
        this.onClearCb = typeof fn === 'function' ? fn : null;
    };

    CommsFeedManager.prototype.setAgents = function (names) {
        this.agentNames = Array.isArray(names) ? names.slice() : [];
        this.renderChips();
    };

    CommsFeedManager.prototype.setFilter = function (fn) {
        this.customFilter = typeof fn === 'function' ? fn : null;
        this.renderList(true);
    };

    CommsFeedManager.prototype.renderChips = function () {
        if (!this.chipsEl) return;

        var counts = {};
        for (var a = 0; a < this.agentNames.length; a++) {
            var name = this.agentNames[a];
            if (name) counts[name] = 0;
        }

        for (var i = 0; i < this.entries.length; i++) {
            var src = this.entries[i].src || 'unknown';
            counts[src] = (counts[src] || 0) + 1;
        }

        var uniqueSources = Object.keys(counts);
        this.chipsEl.innerHTML = '';

        var self = this;
        function createChip(srcLabel, count) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'comms-feed__chip' + (self.selectedSrc === srcLabel ? ' active' : '');
            btn.textContent = srcLabel + ' (' + count + ')';
            btn.addEventListener('click', function () {
                self.selectedSrc = srcLabel;
                self.renderChips();
                self.renderList(true);
            });
            return btn;
        }

        this.chipsEl.appendChild(createChip('ALL', this.entries.length));
        for (var j = 0; j < uniqueSources.length; j++) {
            var s = uniqueSources[j];
            this.chipsEl.appendChild(createChip(s, counts[s]));
        }
    };

    CommsFeedManager.prototype.renderList = function (forceScrollBottom) {
        if (!this.listEl) return;

        var list = this.listEl;
        var wasAtBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 24;

        list.innerHTML = '';

        var visibleEntries = [];
        for (var i = 0; i < this.entries.length; i++) {
            var e = this.entries[i];
            if (this.selectedSrc !== 'ALL' && (e.src || 'unknown') !== this.selectedSrc) {
                continue;
            }
            if (this.customFilter && !this.customFilter(e)) {
                continue;
            }
            visibleEntries.push(e);
        }

        for (var k = 0; k < visibleEntries.length; k++) {
            var item = visibleEntries[k];
            var itemEl = document.createElement('div');

            var isRight = (item.src === 'user' || item.kind === 'prompt');
            itemEl.className = 'comms-feed__item ' + (isRight ? 'comms-feed__item--right' : 'comms-feed__item--left');

            var metaEl = document.createElement('div');
            metaEl.className = 'comms-feed__meta';

            var srcBadge = document.createElement('span');
            srcBadge.className = 'comms-feed__src';
            srcBadge.style.backgroundColor = getSrcColor(item.src);
            srcBadge.textContent = item.src || 'unknown';

            var dstText = '';
            if (item.dst) {
                dstText = ' → ' + item.dst;
            }

            var extraSpan = document.createElement('span');
            extraSpan.className = 'comms-feed__dst';
            extraSpan.textContent = dstText;

            var kindSpan = document.createElement('span');
            kindSpan.className = 'comms-feed__kind comms-feed__kind--' + escapeHtml(item.kind || 'event');
            kindSpan.textContent = item.kind || 'event';

            var timeSpan = document.createElement('span');
            timeSpan.className = 'comms-feed__time';
            timeSpan.textContent = formatTime(item.ts);

            metaEl.appendChild(srcBadge);
            if (item.dst) metaEl.appendChild(extraSpan);
            metaEl.appendChild(kindSpan);
            if (item.taskId != null) {
                var taskSpan = document.createElement('span');
                taskSpan.className = 'comms-feed__tag';
                taskSpan.textContent = '#' + item.taskId;
                metaEl.appendChild(taskSpan);
            }
            metaEl.appendChild(timeSpan);

            var bubbleEl = document.createElement('div');
            bubbleEl.className = 'comms-feed__bubble';
            bubbleEl.textContent = item.text || '';

            itemEl.appendChild(metaEl);
            itemEl.appendChild(bubbleEl);
            list.appendChild(itemEl);
        }

        if (forceScrollBottom || wasAtBottom) {
            list.scrollTop = list.scrollHeight;
        }
    };

    var instance = new CommsFeedManager();

    window.CommsFeed = {
        mount: function (containerEl) {
            instance.mount(containerEl);
        },
        setEntries: function (entries) {
            instance.setEntries(entries);
        },
        appendEntry: function (entry) {
            instance.appendEntry(entry);
        },
        setFilter: function (fn) {
            instance.setFilter(fn);
        },
        setAgents: function (names) {
            instance.setAgents(names);
        },
        onClear: function (fn) {
            instance.onClear(fn);
        }
    };
})();
