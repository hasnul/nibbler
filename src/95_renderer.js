"use strict";

function NewRenderer() {

	let renderer = Object.create(null);

	renderer.engine = NewEngine();								// Still needs its setup() called.
	renderer.tree = NewTreeHandler();
	renderer.grapher = NewGrapher();
	renderer.info_handler = NewInfoHandler();

	// Various state we have to keep track of...

	renderer.pgn_choices = null;								// All games found when opening a PGN file.
	renderer.friendly_draws = New2DArray(8, 8);					// What pieces are drawn in boardfriends. Used to skip redraws.
	renderer.active_square = null;								// Clicked square.
	renderer.hoverdraw_div = -1;
	renderer.hoverdraw_depth = 0;
	renderer.tick = 0;											// How many draw loops we've been through.
	renderer.position_change_time = performance.now();			// Time of the last position change. Used for cooldown on hover draw.

	renderer.node_to_clean = renderer.tree.node;				// The next node to be cleaned up (done when exiting it).

	// Some sync stuff...

	renderer.leela_node = null;									// The last tree node sent to Leela. Generally not cleared upon halting.
	renderer.leela_lock_node = null;							// Non-null only when in "analysis_locked" mode.

	// -------------------------------------------------------------------------------------------------------------------------

	renderer.behave = function() {

		// Called when position changes.
		// Called when behaviour changes.

		switch (config.behaviour) {

		case "halt":
			this.__halt();
			break;

		case "analysis_free":
		case "self_play":
		case "auto_analysis":
			if (!this.engine.running || this.leela_node !== this.tree.node || this.engine.sent_limit !== this.node_limit()) {
				this.__go(this.tree.node);
			}
			break;

		case "analysis_locked":

			// Only send "go" in certain circumstances... the engine.sent_limit condition is for cases like switching from
			// "auto_analysis" mode to "analysis_locked" mode.

			if (!this.engine.running || this.leela_node !== this.leela_lock_node || this.engine.sent_limit !== this.node_limit()) {
				if (this.tree.node === this.leela_lock_node) {		// So moving around in irrelevant positions doesn't trigger.
					this.__go(this.tree.node);
				}
			}
			break;

		case "play_white":
			if (this.tree.node.board.active === "w") {
				this.__go(this.tree.node);
			} else {
				this.__halt();
			}
			break;

		case "play_black":
			if (this.tree.node.board.active === "b") {
				this.__go(this.tree.node);
			} else {
				this.__halt();
			}
			break;

		}
	};

	renderer.position_changed = function(new_game_flag, avoid_confusion) {

		this.escape();

		this.hoverdraw_div = -1;
		this.position_change_time = performance.now();
		fenbox.value = this.tree.node.board.fen(true);

		if (new_game_flag) {
			this.node_to_clean = null;
			this.leela_node = null;
			this.leela_lock_node = null;
			this.set_behaviour("halt");					// Will cause "stop" to be sent
			this.engine.send("ucinewgame");				// Must happen after "stop" is sent.
			this.send_title();
		}

		// When entering a position, clear its searchmoves, unless it's the analysis_locked node.

		if (this.leela_lock_node !== this.tree.node) {
			this.tree.node.searchmoves = [];
		}

		// Caller can tell us the change would cause user confusion for some modes...

		if (avoid_confusion) {
			if (["play_white", "play_black", "self_play", "auto_analysis"].includes(config.behaviour)) {
				this.set_behaviour("halt");
			}
		}

		this.maybe_infer_info();						// Before node_exit_cleanup() so that previous ghost info is available when moving forwards.
		this.behave();
		this.draw();

		this.node_exit_cleanup();						// This feels like the right time to do this.
		this.node_to_clean = this.tree.node;
	};

	renderer.set_behaviour = function(s) {

		// Don't do anything if behaviour is already correct. But
		// "halt" always triggers a behave() call for safety reasons,
		// though engine.js may filter duplicates.

		if (s !== "halt" && s === config.behaviour) {
			return;
		}

		// "analysis_locked" has its own function.

		if (s === "analysis_locked") {
			throw `set_behaviour("analysis_locked") not allowed`;
		}

		this.leela_lock_node = null;
		config.behaviour = s;
		this.behave();
	};

	renderer.go_and_lock = function() {
		this.leela_lock_node = this.tree.node;
		config.behaviour = "analysis_locked";
		this.behave();
	};

	renderer.handle_searchmoves_change = function() {

		if (this.engine.running && this.leela_node === this.tree.node) {
			this.__go(this.leela_node);
		}
	};

	renderer.handle_node_limit_change = function() {

		if (this.engine.sent_limit !== this.node_limit()) {
			if (this.leela_node && config.behaviour !== "halt") {
				this.__go(this.leela_node);
			}
		}
	};

	renderer.play_this_colour = function() {

		if (this.tree.node.board.active === "w") {
			this.set_behaviour("play_white");
		} else {
			this.set_behaviour("play_black");
		}
	};

	// -------------------------------------------------------------------------------------------------------------------------

	renderer.maybe_infer_info = function() {

		// This function creates "ghost" info in the info table when possible and necessary;
		// such info is inferred from ancestral info. It is also deleted upon leaving the node.
		//
		// The whole thing is a bit sketchy, maybe.

		if (config.behaviour !== "halt" && config.behaviour !== "analysis_locked") {
			return;
		}

		let node = this.tree.node;

		if (!node.parent) {
			return;
		}

		if (Object.keys(node.table.moveinfo).length > 0) {
			return;
		}

		// So the current node has no info.

		let moves = [node.move];
		let ancestor = null;

		let foo = node.parent;

		while (foo) {
			if (Object.keys(foo.table.moveinfo).length > 0) {
				ancestor = foo;
				break;
			}
			moves.push(foo.move);
			foo = foo.parent;
		}

		if (!ancestor) {
			return;
		}

		// So we found the closest ancestor with info.

		moves.reverse();

		let oldinfo = ancestor.table.moveinfo[moves[0]];

		if (!oldinfo) {
			return;
		}

		if (Array.isArray(oldinfo.pv) === false || oldinfo.pv.length <= moves.length) {
			return;
		}

		let pv = Array.from(oldinfo.pv);

		for (let n = 0; n < moves.length; n++) {
			if (pv[n] !== moves[n]) {
				return;
			}
		}

		// So, everything matches and we can use the PV...

		let nextmove = pv[moves.length];
		pv = pv.slice(moves.length);

		let new_info = NewInfo(node.board, nextmove);

		new_info.__ghost = true;
		new_info.pv = pv;
		new_info.q = oldinfo.q;
		new_info.cp = oldinfo.cp;
		new_info.multipv = 1;

		// Flip our evals if the colour changes...

		if (oldinfo.board.active !== node.board.active) {
			if (typeof new_info.q === "number") {
				new_info.q *= -1;
			}
			if (typeof new_info.cp === "number") {
				new_info.cp *= -1;
			}
		}

		node.table.moveinfo[nextmove] = new_info;
	};

	renderer.node_exit_cleanup = function() {

		if (!this.node_to_clean || this.node_to_clean.destroyed) {
			return;
		}

		// Remove ghost info; which is only allowed in the node we're currently looking at...

		for (let key of Object.keys(this.node_to_clean.table.moveinfo)) {
			if (this.node_to_clean.table.moveinfo[key].__ghost) {
				delete this.node_to_clean.table.moveinfo[key];
			}
		}

	};

	// -------------------------------------------------------------------------------------------------------------------------

	renderer.move = function(s) {							// It is safe to call this with illegal moves.

		if (typeof s !== "string") {
			console.log(`renderer.move(${s}) - bad argument`);
			return false;
		}

		let board = this.tree.node.board;
		let source = Point(s.slice(0, 2));

		if (!source) {
			console.log(`renderer.move(${s}) - invalid source`);
			return false;
		}

		// First deal with old-school castling in Standard Chess...

		s = board.c960_castling_converter(s);

		// If a promotion character is required and not present, show the promotion chooser and return
		// without committing to anything.

		if (s.length === 4) {
			if ((board.piece(source) === "P" && source.y === 1) || (board.piece(source) === "p" && source.y === 6)) {
				let illegal_reason = board.illegal(s + "q");
				if (illegal_reason !== "") {
					console.log(`renderer.move(${s}) - ${illegal_reason}`);
				} else {
					this.show_promotiontable(s);
				}
				return false;
			}
		}

		// The promised legality check...

		let illegal_reason = board.illegal(s);
		if (illegal_reason !== "") {
			console.log(`renderer.move(${s}) - ${illegal_reason}`);
			return false;
		}

		this.tree.make_move(s);
		this.position_changed();
		return true;
	};

	renderer.random_move = function() {
		let legals = this.tree.node.board.movegen();
		if (legals.length > 0) {
			this.move(RandChoice(legals));
		}
	};

	renderer.node_limit = function() {

		// Given the current state of the config, what is the node limit?

		let cfg_value;

		switch (config.behaviour) {

		case "play_white":
		case "play_black":
		case "self_play":
		case "auto_analysis":

			cfg_value = config.search_nodes_special;
			break;

		default:

			cfg_value = config.search_nodes;
			break;

		}

		// We need to match the values stored in engine.sent_limit.

		if (typeof cfg_value === "number" && cfg_value >= 1) {
			return cfg_value;
		} else {
			return null;
		}
	};

	renderer.play_info_index = function(n) {
		let info_list = this.info_handler.sorted(this.tree.node);
		if (typeof n === "number" && n >= 0 && n < info_list.length) {
			this.move(info_list[n].move);
		}
	};

	// Note that the various tree.methods() return whether or not the current node changed.

	renderer.return_to_lock = function() {
		if (config.behaviour === "analysis_locked") {
			if (this.tree.set_node(this.leela_node)) {		// Fool-proof against null / destroyed.
				this.position_changed(false, true);
			}
		}
	};

	renderer.prev = function() {
		if (this.tree.prev()) {
			this.position_changed(false, true);
		}
	};

	renderer.next = function() {
		if (this.tree.next()) {
			this.position_changed(false, true);
		}
	};

	renderer.goto_root = function() {
		if (this.tree.goto_root()) {
			this.position_changed(false, true);
		}
	};

	renderer.goto_end = function() {
		if (this.tree.goto_end()) {
			this.position_changed(false, true);
		}
	};

	renderer.next_sibling = function() {
		if (this.tree.next_sibling()) {
			this.position_changed(false, true);
		}
	};

	renderer.return_to_main_line = function() {
		if (this.tree.return_to_main_line()) {
			this.position_changed(false, true);
		}
	};

	renderer.delete_node = function() {
		if (this.tree.delete_node()) {
			this.position_changed(false, true);
		}
	};

	renderer.promote_to_main_line = function() {
		this.tree.promote_to_main_line();
	};

	renderer.promote = function() {
		this.tree.promote();
	};

	renderer.delete_other_lines = function() {
		this.tree.delete_other_lines();
	};

	renderer.delete_children = function() {
		this.tree.delete_children();
	};

	renderer.delete_siblings = function() {
		this.tree.delete_siblings();
	};

	renderer.load_from_fenbox = function(s) {

		s = s.trim();

		if (s === this.tree.node.board.fen(true)) {
			return;
		}

		let abnormal = false;

		// Allow loading a Chess 960 position by giving its ID:

		if (s.length <= 3) {
			let n = parseInt(s, 10);
			if (Number.isNaN(n) === false && n < 960) {
				s = c960_fen(n);
				abnormal = true;
			}
		}

		// Allow loading a fruity start position by giving the pieces:

		if (s.length === 8) {
			let ok = true;
			for (let c of s) {
				if (["K", "k", "Q", "q", "R", "r", "B", "b", "N", "n"].includes(c) === false) {
					ok = false;
					break;
				}
			}
			if (ok) {
				s = `${s.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${s.toUpperCase()} w KQkq - 0 1`;
				abnormal = true;
			}
		}

		this.load_fen(s, abnormal);
	};

	renderer.load_fen = function(s, abnormal) {

		let board;

		try {

			board = LoadFEN(s);

			// If the FEN loader thought it looked like normal chess, we must
			// override it if the caller passed the abnormal flag. Note that
			// it is never permissible to go in the opposite direction... if
			// the loader thought it was abnormal, we never say it's normal.

			if (abnormal) {
				board.normalchess = false;
			}

		} catch (err) {
			alert(err);
			return;
		}

		this.tree.replace_tree(NewRoot(board));
		this.position_changed(true, true);
	};

	renderer.new_game = function() {
		this.load_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
	};

	renderer.new_960 = function(n) {
		if (n === undefined) {
			n = RandInt(0, 960);
		}
		this.load_fen(c960_fen(n), true);
	};

	renderer.infobox_to_clipboard = function() {
		let s = infobox.innerText;
		s = ReplaceAll(s, `${config.focus_on_text} `, "");
		s = ReplaceAll(s, `${config.focus_off_text} `, "");
		clipboard.writeText(this.tree.node.board.fen(true) + "\n" + statusbox.innerText + "\n\n" + s);
	};

	// -------------------------------------------------------------------------------------------------------------------------
	// PGN...

	renderer.pgn_to_clipboard = function() {
		PGNToClipboard(this.tree.node);
	};

	renderer.save = function(filename) {
		SavePGN(filename, this.tree.node);
	};

	renderer.open = function(filename) {
		let buf;
		try {
			buf = fs.readFileSync(filename);
		} catch (err) {
			alert(err);
			return;
		}
		this.load_pgn_buffer(buf);
	};

	renderer.load_pgn_from_string = function(s) {
		let buf = Buffer.from(s);
		this.load_pgn_buffer(buf);
	};

	renderer.load_pgn_buffer = function(buf) {

		let new_pgn_choices = PreParsePGN(buf);

		if (new_pgn_choices.length === 1) {
			let success = this.load_pgn_object(new_pgn_choices[0]);
			if (success) {
				this.pgn_choices = new_pgn_choices;			// We only want to set this to a 1 value array if it actually worked.
			}
		} else {
			this.pgn_choices = new_pgn_choices;				// Setting it to a multi-value array is "always" OK.
			this.show_pgn_chooser();						// Now we need to have the user choose a game.
		}
	};

	renderer.load_pgn_object = function(o) {				// Returns true or false - whether this actually succeeded.

		let root_node;

		try {
			root_node = LoadPGNRecord(o);
		} catch (err) {
			alert(err);
			return false;
		}

		this.tree.replace_tree(root_node);
		this.position_changed(true, true);

		return true;
	};

	renderer.show_pgn_chooser = function() {

		if (!this.pgn_choices) {
			alert("No PGN loaded");
			return;
		}

		this.hide_promotiontable();		// Just in case it's up.

		let lines = [];

		let max_ordinal_length = this.pgn_choices.length.toString().length;
		let padding = "";
		for (let n = 0; n < max_ordinal_length - 1; n++) {
			padding += "&nbsp;";
		}

		for (let n = 0; n < this.pgn_choices.length; n++) {

			if (n === 9 || n === 99 || n === 999 || n === 9999 || n === 99999 || n === 999999) {
				padding = padding.slice(0, -6);
			}

			let p = this.pgn_choices[n];

			let s;

			if (p.tags.Result === "1-0") {
				s = `${padding}${n + 1}. <span class="blue">${p.tags.White}</span> - ${p.tags.Black}`;
			} else if (p.tags.Result === "0-1") {
				s = `${padding}${n + 1}. ${p.tags.White} - <span class="blue">${p.tags.Black}</span>`;
			} else {
				s = `${padding}${n + 1}. ${p.tags.White} - ${p.tags.Black}`;
			}

			if (p.tags.Opening) {
				s += `  <span class="gray">(${p.tags.Opening})</span>`;
			}

			lines.push(`<li id="chooser_${n}">${s}</li>`);
		}

		pgnchooser.innerHTML = "<ul>" + lines.join("") + "</ul>";
		pgnchooser.style.display = "block";
	};

	renderer.hide_pgn_chooser = function() {
		pgnchooser.style.display = "none";
	};

	renderer.pgnchooser_click = function(event) {
		let n = EventPathN(event, "chooser_");
		if (typeof n !== "number") {
			return;
		}
		if (this.pgn_choices && n >= 0 && n < this.pgn_choices.length) {
			this.load_pgn_object(this.pgn_choices[n]);
		}
	};

	renderer.validate_pgn = function(filename) {

		let buf;
		try {
			buf = fs.readFileSync(filename);		// i.e. binary buffer object
		} catch (err) {
			alert(err);
			return;
		}

		let pgn_list = PreParsePGN(buf);

		for (let n = 0; n < pgn_list.length; n++) {

			let o = pgn_list[n];

			try {
				LoadPGNRecord(o);
			} catch (err) {
				alert(`Game ${n + 1} - ${err.toString()}`);
				return false;
			}
		}

		alert(`This file seems OK. ${pgn_list.length} ${pgn_list.length === 1 ? "game" : "games"} checked.`);
		return true;
	};

	// -------------------------------------------------------------------------------------------------------------------------
	// Engine stuff...

	renderer.receive = function(s) {

		debug.receive = debug.receive ? debug.receive + 1 : 1;

		if (s.startsWith("info")) {

			if (this.leela_node && !this.leela_node.destroyed) {
				this.info_handler.receive(s, this.leela_node);
			}

		} else if (s.startsWith("error")) {

			// If this comes at the start, we want to display it in the infobox, but if we're already
			// drawing the infobox for real, we'll need to flash it up in the status box instead...

			if (this.info_handler.ever_received_info) {
				this.set_special_message(s, "red");
			}
			this.info_handler.err_receive(s);

		} else if (s.startsWith("id name")) {

			if (s.includes("Lc0")) {
				for (let n = 10; n < messages.min_version; n++) {
					if (s.includes(`v0.${n}`)) {
						this.info_handler.err_receive("");
						this.info_handler.err_receive(`<span class="blue">${messages.obsolete_leela}</span>`);
						this.info_handler.err_receive("");
					}
				}
			} else {
				this.info_handler.err_receive(s.slice("id name".length).trim());
			}

		} else if (s.startsWith("bestmove")) {

			this.update_graph_eval();				// Now's the last chance to update our graph eval for this node.

			switch (config.behaviour) {

			case "self_play":
			case "play_white":
			case "play_black":

				if (this.leela_node === this.tree.node) {

					let tokens = s.split(" ").filter(z => z !== "");
					let ok = this.move(tokens[1]);

					if (!ok) {
						LogBoth(`BAD BESTMOVE (${tokens[1]}) IN POSITION ${this.tree.node.board.fen(true)}`);
						if (!this.warned_bad_bestmove) {
							alert(messages.bad_bestmove);
							this.warned_bad_bestmove = true;
						}
					}
				} else {
					this.set_behaviour("halt");				// Can this ever happen?
				}

				break;

			case "auto_analysis":

				if (this.leela_node === this.tree.node) {

					if (this.tree.next()) {
						this.position_changed(false, false);
					} else {
						this.set_behaviour("halt");
					}

				} else {
					this.set_behaviour("halt");				// Can this ever happen?
				}

				break;

			case "analysis_free":
			case "analysis_locked":

				// We hit the node limit. No need to change behaviour.
				break;

			}
		}

		debug.receive -= 1;
	};

	renderer.err_receive = function(s) {

		// If Leela announces it's using BLAS, adjust some UCI settings that can drastically improve performance.
		// This is pretty crude.

		if (config.options.MaxPrefetch === undefined && config.options.MinibatchSize === undefined && s.startsWith("Creating backend [blas]")) {
			this.engine.setoption("MaxPrefetch", 0);
			this.engine.setoption("MinibatchSize", 8);
			this.info_handler.err_receive(s);
			this.info_handler.err_receive(`<span class="blue">${messages.settings_for_blas}</span>`);	// Announces [MaxPrefetch = 0, MinibatchSize = 8]
			return;
		}

		// Some highlights... this is obviously super-fragile based on the precise strings Leela sends.

		if (s.startsWith("Found configuration file: ")) {
			this.info_handler.err_receive(HighLightString(s, "Found configuration file: ", "blue"));
			return;
		}

		if (s.startsWith("Loading Syzygy tablebases from ")) {
			this.info_handler.err_receive(HighLightString(s, "Loading Syzygy tablebases from ", "blue"));
			return;
		}

		// We can also send an IPC message so main.js knows what WeightsFile we have...

		if (s.startsWith("Loading weights file from: ")) {
			ipcRenderer.send("ack_weightsfile", s.slice(26).trim());
			this.info_handler.err_receive(HighLightString(s, "Loading weights file from: ", "blue"));
			return;
		}

		if (s.startsWith("Found pb network file: ")) {
			ipcRenderer.send("ack_weightsfile", s.slice(22).trim());
			this.info_handler.err_receive(HighLightString(s, "Found pb network file: ", "blue"));
			return;
		}

		this.info_handler.err_receive(s);
	};

	// The go and halt methods should not be called directly.

	renderer.__halt = function() {
		this.engine.send("stop");
	};

	renderer.__go = function(node) {

		this.hide_pgn_chooser();

		this.__halt();

		if (!node || node.destroyed || node.terminal_reason() !== "") {
			this.leela_node = null;			// So that terminal positions don't leave this set to some previous node.
			return;
		}

		let root_fen = this.tree.root.board.fen(false);
		let setup = `fen ${root_fen}`;

		// Leela seems to time "readyok" correctly after "position" commands.
		// After sending "isready" we'll ignore Leela output until "readyok" comes.

		this.engine.send(`position ${setup} moves ${node.history().join(" ")}`);
		Log(node.board.graphic());
		this.engine.send("isready");

		let s;
		let n = this.node_limit();

		if (!n) {
			s = "go infinite";
		} else {
			s = `go nodes ${n}`;
		}

		if (config.searchmoves_buttons && Array.isArray(node.searchmoves) && node.searchmoves.length > 0) {
			node.validate_searchmoves();	// Leela can crash on illegal searchmoves.
			s += " searchmoves";
			for (let move of node.searchmoves) {
				s += " " + move;
			}
		}

		this.engine.send(s);
		this.leela_node = node;
	};

	renderer.soft_engine_reset = function() {
		this.position_changed(true);
	};

	renderer.set_uci_option = function(name, val, save_to_cfg) {
		if (save_to_cfg) {
			if (val === null || val === undefined) {
				delete config.options[name];
			} else {
				config.options[name] = val;
			}
			config_io.save(config);
		}
		if (val === null || val === undefined) {
			val = "";
		}
		let sent = this.engine.setoption(name, val);
		this.set_special_message(sent, "blue");
	};

	renderer.set_uci_option_permanent = function(name, val) {
		this.set_uci_option(name, val, true);
	};

	renderer.disable_syzygy = function() {
		delete config.options["SyzygyPath"];
		config_io.save(config);
		this.restart_engine();
	};

	renderer.switch_weights = function(filename) {
		this.info_handler.stderr_log = "";							// Avoids having confusing stale messages
		this.set_uci_option_permanent("WeightsFile", filename);
	};

	renderer.adjust_node_limit = function(direction, special_flag) {

		let cfg_value = special_flag ? config.search_nodes_special : config.search_nodes;

		if (direction > 0) {

			if (typeof cfg_value !== "number" || cfg_value <= 0) {				// Already unlimited
				this.set_node_limit_generic(null, special_flag);
				return;
			}

			for (let i = 0; i < limit_options.length; i++) {
				if (limit_options[i] > cfg_value) {
					this.set_node_limit_generic(limit_options[i], special_flag);
					return;
				}
			}

			this.set_node_limit_generic(null, special_flag);

		} else {

			if (typeof cfg_value !== "number" || cfg_value <= 0) {				// Unlimited; reduce to highest finite option
				this.set_node_limit_generic(limit_options[limit_options.length - 1], special_flag);
				return;
			}

			for (let i = limit_options.length - 1; i >= 0; i--) {
				if (limit_options[i] < cfg_value) {
					this.set_node_limit_generic(limit_options[i], special_flag);
					return;
				}
			}

			this.set_node_limit_generic(1, special_flag);
		}
	};

	renderer.set_node_limit = function(val) {
		this.set_node_limit_generic(val, false);
	};

	renderer.set_node_limit_special = function(val) {
		this.set_node_limit_generic(val, true);
	};

	renderer.set_node_limit_generic = function(val, special_flag) {

		if (typeof val !== "number" || val <= 0) {
			val = null;
		}

		let msg_start = special_flag ? "Special node limit" : "Node limit";
		let ack_type = special_flag ? "ack_special_node_limit" : "ack_node_limit";

		if (val) {
			this.set_special_message(`${msg_start} now ${CommaNum(val)}`, "blue");
		} else {
			this.set_special_message(`${msg_start} removed!`, "blue");
		}

		if (special_flag) {
			config.search_nodes_special = val;
		} else {
			config.search_nodes = val;
		}
		config_io.save(config);
		this.handle_node_limit_change();

		if (val) {
			ipcRenderer.send(ack_type, CommaNum(val));
		} else {
			ipcRenderer.send(ack_type, "Unlimited");
		}
	};

	renderer.switch_engine = function(filename) {
		this.set_behaviour("halt");
		config.path = filename;
		config_io.save(config);
		this.engine_start(config.path, config.args);
		this.engine_initial_comms(config.options);
	};

	renderer.restart_engine = function() {
		this.set_behaviour("halt");
		this.engine_start(config.path, config.args);
		this.engine_initial_comms(config.options);
	};

	renderer.engine_start = function(filepath, args) {

		if (this.engine.exe) {						// We already have an engine connection (possibly non-functioning, but still...)
			this.engine.shutdown();
			this.engine = NewEngine();
		}

		this.info_handler.reset_engine_info();
		this.info_handler.must_draw_infobox();		// To displace the new stderr log that appears.

		if (typeof filepath !== "string" || fs.existsSync(filepath) === false) {

			if (!config.failure) {					// Only show the following if there isn't a bigger problem...
				this.err_receive(`<span class="blue">${messages.engine_not_present}</span>`);
				this.err_receive("");
			}
			return;
		}

		if (Array.isArray(args) === false) {
			args = [];
		}

		this.engine.setup(filepath, args, this.receive.bind(this), this.err_receive.bind(this));
	};

	renderer.engine_initial_comms = function(options) {

		if (typeof options !== "object" || options === null) {
			options = {};
		}

		this.engine.send("uci");

		// Here we send the leela_normal_options...

		for (let key of Object.keys(leela_normal_options)) {
			this.engine.setoption(key, leela_normal_options[key]);
		}

		for (let key of Object.keys(options)) {
			this.engine.setoption(key, options[key]);	// Allowing user to override even the above normal options.
		}

		this.engine.setoption("UCI_Chess960", true);	// We always use Chess 960 mode now, for consistency.

		this.engine.send("ucinewgame");
	};

	// -------------------------------------------------------------------------------------------------------------------------
	// Settings etc...

	renderer.toggle = function(option) {

		// Cases with their own handler...

		if (option === "flip") {
			this.toggle_flip();
			return;
		}

		// Normal cases...

		config[option] = !config[option];
		config_io.save(config);

		this.info_handler.must_draw_infobox();

		// Cases that have additional actions after...

		if (option === "searchmoves_buttons") {
			this.tree.node.searchmoves = [];		// This is reasonable regardless of which way the toggle went.
			this.handle_searchmoves_change();
		}
	};

	renderer.toggle_flip = function() {				// config.flip should not be directly set, call this function instead.

		config.flip = !config.flip;

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 4; y++) {

				let first = document.getElementById(`overlay_${S(x, y)}`);
				let second = document.getElementById(`overlay_${S(7 - x, 7 - y)}`);
				SwapElements(first, second);

				first = document.getElementById(`underlay_${S(x, y)}`);
				second = document.getElementById(`underlay_${S(7 - x, 7 - y)}`);
				SwapElements(first, second);
			}
		}

		this.draw();								// For the canvas stuff.
	};

	renderer.invert_searchmoves = function() {

		if (!config.searchmoves_buttons || Array.isArray(this.tree.node.searchmoves) === false) {
			return;
		}

		// It's no disaster if the result is wrong somehow, because
		// searchmoves are validated before being sent to Leela.

		let moveset = Object.create(null);

		for (let move of Object.keys(this.tree.node.table.moveinfo)) {
			moveset[move] = true;
		}

		for (let move of this.tree.node.searchmoves) {
			delete moveset[move];
		}

		this.tree.node.searchmoves = Object.keys(moveset);
		this.handle_searchmoves_change();
	};

	renderer.clear_searchmoves = function() {
		this.tree.node.searchmoves = [];
		this.handle_searchmoves_change();
	};

	renderer.escape = function() {					// Set things into a clean state.
		this.hide_pgn_chooser();
		this.hide_promotiontable();
		this.set_active_square(null);
	};

	renderer.toggle_debug_css = function() {
		let ss = document.styleSheets[0];
		let i = 0;
		for (let rule of Object.values(ss.cssRules)) {
			if (rule.selectorText && rule.selectorText === "*") {
				ss.deleteRule(i);
				return;
			}
			i++;
		}
		ss.insertRule("* {outline: 1px dotted red;}");
	};

	renderer.console = function(...args) {
		console.log(...args);
	};

	renderer.set_pgn_font_size = function(n) {
		movelist.style["font-size"] = n.toString() + "px";
		fenbox.style["font-size"] = n.toString() + "px";
		config.pgn_font_size = n;
		config.fen_font_size = n;
		config_io.save(config);
	};

	renderer.small_arrows = function() {
		config.arrow_width = 8;
		config.arrowhead_radius = 12;
		config.board_font = "18px Arial";
		config_io.save(config);
	};

	renderer.medium_arrows = function() {
		config.arrow_width = 12;
		config.arrowhead_radius = 18;
		config.board_font = "24px Arial";
		config_io.save(config);
	};

	renderer.large_arrows = function() {
		config.arrow_width = 16;
		config.arrowhead_radius = 24;
		config.board_font = "32px Arial";
		config_io.save(config);
	};

	renderer.giant_arrows = function() {
		config.arrow_width = 24;
		config.arrowhead_radius = 32;
		config.board_font = "40px Arial";
		config_io.save(config);
	};

	renderer.set_info_font_size = function(n) {
		infobox.style["font-size"] = n.toString() + "px";
		statusbox.style["font-size"] = n.toString() + "px";
		config.info_font_size = n;
		config.status_font_size = n;
		config_io.save(config);
		this.rebuild_sizes();
	};

	renderer.set_graph_height = function(sz) {
		config.graph_height = sz;
		config_io.save(config);
		this.rebuild_sizes();
		this.grapher.draw(this.tree.node, true);
	};

	renderer.set_board_size = function(sz) {
		config.square_size = Math.floor(sz / 8);
		config.board_size = config.square_size * 8;
		config_io.save(config);
		this.rebuild_sizes();
	};

	renderer.rebuild_sizes = function() {

		// This assumes everything already exists.
		// Derived from the longer version in start.js, which it does not replace.
		// Can be called without sz to simply recalculate everything and save (but this flickers).

		boardfriends.width = canvas.width = boardsquares.width = config.board_size;
		boardfriends.height = canvas.height = boardsquares.height = config.board_size;

		boardfriends.style.left = canvas.style.left = boardsquares.offsetLeft.toString() + "px";
		boardfriends.style.top = canvas.style.top = boardsquares.offsetTop.toString() + "px";

		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				let td1 = document.getElementById("underlay_" + S(x, y));
				let td2 = document.getElementById("overlay_" + S(x, y));
				td1.width = td2.width = config.square_size;
				td1.height = td2.height = config.square_size;
			}
		}

		// Making the heights of the right side divs is something I never figured out with CSS...

		if (config.graph_height <= 0) {
			graphbox.style.display = "none";
		} else {
			graphbox.style.height = config.graph_height.toString() + "px";
			graph.style.height = config.graph_height.toString() + "px";
			graphbox.style.display = "";
		}

		let infobox_top = infobox.getBoundingClientRect().top;
		let canvas_bottom = canvas.getBoundingClientRect().bottom;
		let graph_top = canvas_bottom - (graphbox.getBoundingClientRect().bottom - graphbox.getBoundingClientRect().top);

		let infobox_margin_adjustment = config.graph_height <= 0 ? 0 : 10;		// Bottom margin irrelevant if no graph.
		infobox.style.height = (graph_top - infobox_top - infobox_margin_adjustment).toString() + "px";

		promotiontable.style.left = (boardsquares.offsetLeft + config.square_size * 2).toString() + "px";
		promotiontable.style.top = (boardsquares.offsetTop + config.square_size * 3.5).toString() + "px";
		promotiontable.style["background-color"] = config.active_square;

		this.draw();
	};

	renderer.save_window_size = function() {
		config.width = window.innerWidth;
		config.height = window.innerHeight;
		config_io.save(config);
	};

	renderer.fire_gc = function() {
		if (!global || !global.gc) {
			alert("Unable.");
		} else {
			global.gc();
		}
	};

	renderer.show_sync_status = function() {
		alert(`readyok: ${this.engine.readyok_required}, bestmove: ${this.engine.bestmove_required}`);
	};

	renderer.show_dropped_inputs = function() {
		alert(`total_dropped_inputs: ${total_dropped_inputs}`);		// This is a global variable in start.js
	};

	renderer.log_ram = function() {
		console.log(`RAM after ${Math.floor(performance.now() / 1000)} seconds:`);
		for (let foo of Object.entries(process.memoryUsage())) {
			let type = foo[0] + " ".repeat(12 - foo[0].length);
			let mb = foo[1] / (1024 * 1024);
			let mb_rounded = Math.floor(mb * 1000) / 1000;			// 3 d.p.
			console.log(type, "(MB)", mb_rounded);
		}
	};

	renderer.save_config = function() {			// Just for the dev menu - everything else can just call config_io.save(config) directly.
		config_io.save(config);
	};

	renderer.run_script = function(filename) {

		const disallowed = ["position", "go", "stop", "ponderhit", "quit"];

		let buf;
		try {
			buf = fs.readFileSync(filename);
		} catch (err) {
			alert(err);
			return;
		}

		this.set_behaviour("halt");

		let s = buf.toString();
		let lines = s.split("\n").map(z => z.trim()).filter(z => z !== "");

		for (let line of lines) {
			for (let d of disallowed) {
				if (line.startsWith(d)) {
					this.set_special_message(`${messages.invalid_script}`, "yellow");
					console.log(`Refused to run script: ${filename}`);
					return;
				}
			}
		}

		console.log(`Running script: ${filename}`);

		for (let line of lines) {
			this.engine.send(line);
			console.log(line);
		}
		this.set_special_message(`${path.basename(filename)}: Sent ${lines.length} lines`, "blue");
	};

	renderer.generate_simple_book = function() {		// For https://github.com/fohristiwhirl/lc0_lichess

		let node_histories = [];
		let text_lines = [];

		for (let end_node of this.tree.root.end_nodes()) {
			node_histories.push(end_node.node_history());
		}

		for (let node_history of node_histories) {

			let elements = [];

			for (let node of node_history) {

				if (!node.move) {						// Root node, no move present
					continue;
				}

				let s = node.move;

				// Convert castling moves from e1h1 format to standard...
				// Do this by detecting that nothing landed on the nominal target square.

				if (s === "e1h1" && node.board.state[7][7] === "") s = "e1g1";
				if (s === "e1a1" && node.board.state[0][7] === "") s = "e1c1";
				if (s === "e8h8" && node.board.state[7][0] === "") s = "e8g8";
				if (s === "e8a8" && node.board.state[0][0] === "") s = "e8c8";

				elements.push(s);
			}

			text_lines.push(elements.join(" "));
		}

		text_lines = text_lines.map(s => "\t\"" + s + "\"");

		console.log("[\n" + text_lines.join(",\n") + "\n]");
	};

	// -------------------------------------------------------------------------------------------------------------------------
	// Clicks, drops, mouse stuff...

	renderer.set_active_square = function(new_point) {

		// We do things this way so it's snappy and responsive. We could do it
		// in the canvas instead, but then we'd need a whole canvas redraw
		// every time it changes (or accept the lag). Meh.

		let old_point = this.active_square;

		if (old_point) {
			let td = document.getElementById("underlay_" + old_point.s);
			td.style["background-color"] = (old_point.x + old_point.y) % 2 === 0 ? config.light_square : config.dark_square;
		}

		this.active_square = null;

		if (new_point) {
			let td = document.getElementById("underlay_" + new_point.s);
			td.style["background-color"] = config.active_square;
			this.active_square = new_point;
		}
	};

	renderer.boardfriends_click = function(event) {

		let s = EventPathString(event, "overlay_");
		let p = Point(s);

		if (!p) {
			return;
		}

		this.hide_promotiontable();		// Just in case it's up.

		let ocm = this.info_handler.one_click_moves[p.x][p.y];
		let board = this.tree.node.board;

		if (!this.active_square && ocm && board.colour(p) !== board.active) {		// Note that we test colour difference
			this.set_active_square(null);											// to disallow castling moves from OCM
			this.move(ocm);															// since the dest is the rook (which
			return;																	// the user might want to click on.)
		}

		if (this.active_square) {
			let move = this.active_square.s + p.s;		// e.g. "e2e4" - note promotion char is handled by renderer.move()
			this.set_active_square(null);
			this.move(move);
			return;
		}

		if (board.active === "w" && board.is_white(p)) {
			this.set_active_square(p);
		}
		if (board.active === "b" && board.is_black(p)) {
			this.set_active_square(p);
		}
	};

	renderer.infobox_click = function(event) {

		let moves = this.info_handler.moves_from_click(event);

		if (!moves || moves.length === 0) {				// We do assume length > 0 below.
			this.maybe_searchmove_click(event);
			this.maybe_return_ancestor_click(event);
			return;
		}

		let illegal_reason = this.tree.node.board.sequence_illegal(moves);
		if (illegal_reason !== "") {
			console.log("infobox_click(): " + illegal_reason);
			return;
		}

		// Normal version...

		if (!config.serious_analysis_mode) {
			this.tree.make_move_sequence(moves);
			this.position_changed(false, true);
			return;
		}

		// OK, so we're in Serious Analysis Mode (tm). We don't change our place in the tree.

		this.tree.add_move_sequence(moves);
	};

	renderer.maybe_searchmove_click = function(event) {

		let sm = this.info_handler.searchmove_from_click(event);

		if (!sm) {
			return;
		}

		if (this.tree.node.searchmoves.includes(sm)) {
			this.tree.node.searchmoves = this.tree.node.searchmoves.filter(move => move !== sm);
		} else {
			this.tree.node.searchmoves.push(sm);
		}

		this.handle_searchmoves_change();
	};

	renderer.maybe_return_ancestor_click = function(event) {

		// This rather relies on the details of the inference system.
		// Instead, perhaps we should just pre-store the ancestor node in some variable.

		if (!EventPathString(event, "ancestor_return")) {
			return;
		}

		let ancestor = null;

		let foo = this.tree.node.parent;

		while (foo) {
			if (Object.keys(foo.table.moveinfo).length > 0) {
				ancestor = foo;
				break;
			}
			foo = foo.parent;
		}

		if (!ancestor) {
			return;
		}

		if (this.tree.set_node(ancestor)) {
			this.position_changed(false, true);
		}
	};

	renderer.movelist_click = function(event) {
		if (this.tree.handle_click(event)) {
			this.position_changed(false, true);
		}
	};

	renderer.winrate_click = function(event) {

		let node = this.grapher.node_from_click(this.tree.node, event);

		if (!node) {
			return;
		}

		if (this.tree.set_node(node)) {
			this.position_changed(false, true);
		}
	};

	renderer.statusbox_click = function(event) {

		if (EventPathString(event, "gobutton")) {
			this.set_behaviour("analysis_free");
			return;
		}

		if (EventPathString(event, "lock_return")) {
			this.return_to_lock();
			return;
		}
	};

	renderer.show_promotiontable = function(partial_move) {

		promotiontable.innerHTML = "";

		let tr = document.createElement("tr");
		promotiontable.appendChild(tr);

		let pieces = this.tree.node.board.active === "w" ? ["Q", "R", "B", "N"] : ["q", "r", "b", "n"];

		for (let piece of pieces) {

			let td = document.createElement("td");
			td.width = config.square_size;
			td.height = config.square_size;
			td.style["background-image"] = images[piece].string_for_bg_style;
			td.style["background-size"] = "contain";

			// This isn't a memory leak is it? The handlers are deleted when the element is deleted, right?

			td.addEventListener("mousedown", () => {
				this.hide_promotiontable();
				this.move(partial_move + piece.toLowerCase());
			});

			tr.appendChild(td);
		}

		promotiontable.style.display = "block";
	};

	renderer.hide_promotiontable = function() {
		promotiontable.style.display = "none";
	};

	renderer.handle_drop = function(event) {

		// Note to self - examining the event in the console can be misleading
		// because the object seems to get changed after it's finished firing
		// or something.

		// Just about any drop should clear the active square...

		this.set_active_square(null);

		// Is it a file?

		if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0] && event.dataTransfer.files[0].path) {
			this.open(event.dataTransfer.files[0].path);
			return;
		}

		// Is it a piece?

		let text_data = event.dataTransfer.getData("text");
		if (text_data.startsWith("overlay_")) {

			let source = Point(text_data.slice(8, 10));		// Possibly null
			let dest = null;

			let path = event.path || (event.composedPath && event.composedPath());

			if (path) {
				for (let item of path) {
					if (typeof item.id === "string" && item.id.startsWith("overlay_")) {
						dest = Point(item.id.slice(8, 10));
						break;
					}
				}
			}

			if (source && dest) {
				this.move(source.s + dest.s);
			}

			return;
		}
	};

	renderer.mouse_point = function() {
		let overlist = document.querySelectorAll(":hover");
		for (let item of overlist) {
			if (typeof item.id === "string" && item.id.startsWith("overlay_")) {
				return Point(item.id.slice(8));		// Possibly null
			}
		}
		return null;
	};

	renderer.send_title = function() {
		let title = "Nibbler";
		let root = this.tree.root;
		if (root.tags && root.tags.White && root.tags.White !== "White" && root.tags.Black && root.tags.Black !== "Black") {
			title += `: ${root.tags.White} - ${root.tags.Black}`;
		}
		ipcRenderer.send("set_title", title);
	};

	// -------------------------------------------------------------------------------------------------------------------------
	// General draw code...

	renderer.draw_friendlies_in_table = function() {

		let position = this.tree.node.board;

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {

				let piece_to_draw = "";

				if (position.colour(Point(x, y)) === position.active) {
					piece_to_draw = position.state[x][y];
				}

				if (piece_to_draw === this.friendly_draws[x][y]) {
					continue;
				}

				// So if we get to here, we need to draw...

				this.friendly_draws[x][y] = piece_to_draw;

				let s = S(x, y);
				let td = document.getElementById("overlay_" + s);

				if (piece_to_draw === "") {
					td.style["background-image"] = "none";
					td.draggable = false;
				} else {
					td.style["background-image"] = images[piece_to_draw].string_for_bg_style;
					td.style["background-size"] = "contain";
					td.draggable = true;
				}
			}
		}
	};

	renderer.draw_move_in_canvas = function() {

		if (typeof config.move_colour_alpha !== "number" || config.move_colour_alpha <= 0) {
			return;
		}

		let move = this.tree.node.move;

		if (typeof move !== "string") {
			return;
		}

		let source = Point(move.slice(0, 2));
		let dest = Point(move.slice(2, 4));

		if (!source || !dest) {
			return;
		}

		let points = PointsBetween(source, dest);

		boardctx.fillStyle = config.move_colour;
		boardctx.globalAlpha = config.move_colour_alpha;

		for (let p of points) {
			let cc = CanvasCoords(p.x, p.y);
			boardctx.fillRect(cc.x1, cc.y1, config.square_size, config.square_size);
		}

		boardctx.globalAlpha = 1;
	};

	renderer.draw_enemies_in_canvas = function() {

		let board = this.tree.node.board;

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {

				if (board.state[x][y] === "" || board.colour(Point(x, y)) === board.active) {
					continue;
				}

				let piece = board.state[x][y];
				let cc = CanvasCoords(x, y);
				boardctx.drawImage(images[piece], cc.x1, cc.y1, config.square_size, config.square_size);
			}
		}
	};

	renderer.hoverdraw = function() {

		if (!config.hover_draw) {
			return false;
		}

		if (performance.now() - this.position_change_time < 1000) {
			return false;
		}

		let overlist = document.querySelectorAll(":hover");

		let div_index = null;

		for (let item of overlist) {
			if (typeof item.id === "string" && item.id.startsWith("infoline_")) {
				div_index = parseInt(item.id.slice("infoline_".length), 10);
				break;
			}
		}

		if (typeof div_index !== "number" || Number.isNaN(div_index)) {
			return false;
		}

		let info = this.info_handler.sorted(this.tree.node)[div_index];			// Possibly undefined

		if (!info || Array.isArray(info.pv) === false || info.pv.length === 0) {
			return false;
		}

		if (config.hover_method === 0) {
			return this.hoverdraw_animate(div_index, info);			// Sets this.hoverdraw_div
		} else if (config.hover_method === 1) {
			return this.hoverdraw_single(div_index, overlist);		// Sets this.hoverdraw_div
		} else if (config.hover_method === 2) {
			return this.hoverdraw_final(div_index, info);			// Sets this.hoverdraw_div
		} else {
			return false;											// Caller must set this.hoverdraw_div to -1
		}
	};

	renderer.hoverdraw_animate = function(div_index, info) {

		// If the user is hovering over an unexpected div index in the infobox, reset depth...

		if (div_index !== this.hoverdraw_div) {
			this.hoverdraw_div = div_index;
			this.hoverdraw_depth = 0;
		}

		// Sometimes increase depth...

		if (this.tick % config.animate_delay_multiplier === 0) {
			this.hoverdraw_depth++;
		}

		return this.draw_fantasy_from_moves(info.pv.slice(0, this.hoverdraw_depth));	// Relies on slice() being safe if depth > length
	};

	renderer.hoverdraw_single = function(div_index, overlist) {

		this.hoverdraw_div = div_index;

		let hover_item = null;

		for (let item of overlist) {
			if (typeof item.id === "string" && item.id.startsWith("infobox_")) {
				hover_item = item;
				break;
			}
		}

		if (!hover_item) {
			return false;
		}

		let moves = this.info_handler.moves_from_click_n(parseInt(hover_item.id.slice("infobox_".length), 10));

		if (Array.isArray(moves) === false || moves.length === 0) {
			return false;
		}

		return this.draw_fantasy_from_moves(moves);
	};

	renderer.hoverdraw_final = function(div_index, info) {

		this.hoverdraw_div = div_index;
		return this.draw_fantasy_from_moves(info.pv);

	};

	renderer.draw_fantasy_from_moves = function(moves) {

		// Don't assume moves is an array of legal moves, or even an array.

		if (Array.isArray(moves) === false) {
			return false;
		}

		let board = this.tree.node.board;

		for (let move of moves) {
			let illegal_reason = board.illegal(move);
			if (illegal_reason !== "") {
				return false;
			}
			board = board.move(move);
		}

		this.draw_fantasy(board);
		return true;
	};

	renderer.draw_fantasy = function(board) {

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {

				boardctx.fillStyle = (x + y) % 2 === 0 ? config.light_square : config.dark_square;

				let cc = CanvasCoords(x, y);
				boardctx.fillRect(cc.x1, cc.y1, config.square_size, config.square_size);

				if (board.state[x][y] === "") {
					continue;
				}

				let piece = board.state[x][y];
				boardctx.drawImage(images[piece], cc.x1, cc.y1, config.square_size, config.square_size);
			}
		}
	};

	renderer.draw = function() {

		debug.draw = debug.draw ? debug.draw + 1 : 1;

		// We do the :hover reaction first. This way, we are detecting hover based on the previous cycle's state.
		// This should prevent the sort of flicker that can occur if we try to detect hover based on changes we
		// just made (i.e. if we drew then detected hover instantly).

		boardctx.clearRect(0, 0, canvas.width, canvas.height);
		let did_hoverdraw = this.hoverdraw();

		let arrow_spotlight_square = config.click_spotlight ? this.active_square : null;
		let next_move = config.next_move_arrow && this.tree.node.children.length > 0 ? this.tree.node.children[0].move : null;

		if (did_hoverdraw) {
			boardfriends.style.display = "none";
			canvas.style.outline = "2px dashed #b4b4b4";
		} else {
			this.hoverdraw_div = -1;
			boardfriends.style.display = "block";
			canvas.style.outline = "none";
			this.draw_move_in_canvas();
			this.draw_enemies_in_canvas();
			this.info_handler.draw_arrows(this.tree.node, arrow_spotlight_square, next_move);
			this.draw_friendlies_in_table();
		}

		this.draw_statusbox();
		this.draw_infobox();

		this.grapher.draw(this.tree.node);

		debug.draw -= 1;
	};

	renderer.draw_statusbox = function() {

		let analysing_other = null;

		if (config.behaviour === "analysis_locked" && this.leela_node && this.leela_node !== this.tree.node) {
			if (!this.leela_node.parent) {
				analysing_other = "root";
			} else {
				analysing_other = "position after " + this.leela_node.token(false, true);
			}
		}

		this.info_handler.draw_statusbox(
			this.tree.node,
			this.engine,
			Math.max(this.engine.readyok_required, this.engine.bestmove_required - 1),		// How far out of sync we are, commonly 0
			analysing_other
		);
	};

	renderer.draw_infobox = function() {
		this.info_handler.draw_infobox(
			this.tree.node,
			this.mouse_point(),
			this.active_square,
			this.tree.node.board.active,
			this.hoverdraw_div);
	};

	renderer.set_special_message = function(s, css_class) {
		this.info_handler.set_special_message(s, css_class);
		this.draw_statusbox();
	};

	renderer.spin = function() {
		this.tick++;
		this.draw();
		this.update_graph_eval();
		if (config.behaviour !== "halt" && Math.max(this.engine.readyok_required, this.engine.bestmove_required) > 10) {
			this.set_behaviour("halt");			// Stop the engine if we get too far out of sync. See issue #57.
		}
		setTimeout(this.spin.bind(this), config.update_delay);
	};

	renderer.update_graph_eval = function() {

		// Occasionally update the eval (for graphs) of whatever Leela is looking at.

		if (!this.leela_node || this.leela_node.destroyed) {
			return;
		}

		let info = this.info_handler.sorted(this.leela_node)[0];		// Possibly undefined.
		if (info) {
			this.leela_node.table.update_eval_from_move(info.move);
		}

	};

	return renderer;
}
