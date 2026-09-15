'use strict';

const session = require('express-session');

/**
 * Sessions live in the same SQLite database as everything else, so a restart
 * keeps people signed in and there is no second piece of infrastructure.
 */
function createSessionStore(db, options = {}) {
  const Store = session.Store;

  class SqliteStore extends Store {
    constructor() {
      super();
      this.db = db;
      this.selectStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?');
      this.upsertStmt = db.prepare(
        `INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data`
      );
      this.touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
      this.deleteStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
      this.sweepStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
      this.timer = setInterval(() => this.sweep(), 60 * 60 * 1000);
      if (this.timer.unref) this.timer.unref();
    }

    expiryFor(sess) {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 14 * 24 * 60 * 60 * 1000;
      const effective = sess && sess.accountId
        ? maxAge : Math.min(maxAge, Number(options.anonymousMaxAgeMs || 60 * 60_000));
      return Date.now() + effective;
    }

    get(sid, callback) {
      try {
        const row = this.selectStmt.get(sid, Date.now());
        callback(null, row ? JSON.parse(row.data) : null);
      } catch (err) {
        callback(err);
      }
    }

    set(sid, sess, callback) {
      try {
        this.upsertStmt.run(sid, this.expiryFor(sess), JSON.stringify(sess));
        callback(null);
      } catch (err) {
        callback(err);
      }
    }

    touch(sid, sess, callback) {
      try {
        // An unchanged session only needs its expiry extended. Rewriting the
        // full JSON document on every page view creates needless writer
        // contention with large migration batches. A missed touch is safe:
        // the existing authenticated session still has its normal long TTL.
        this.touchStmt.run(this.expiryFor(sess), sid);
        callback(null);
      } catch (err) {
        if (err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_BUSY_SNAPSHOT')) {
          callback(null);
          return;
        }
        callback(err);
      }
    }

    destroy(sid, callback) {
      try {
        this.deleteStmt.run(sid);
        callback(null);
      } catch (err) {
        callback(err);
      }
    }

    sweep() {
      try {
        this.sweepStmt.run(Date.now());
      } catch {
        /* a failed sweep is not worth crashing the server over */
      }
    }

    close() {
      clearInterval(this.timer);
    }
  }

  return new SqliteStore();
}

module.exports = { createSessionStore };
