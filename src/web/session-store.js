'use strict';

const session = require('express-session');

/**
 * Sessions live in the same SQLite database as everything else, so a restart
 * keeps people signed in and there is no second piece of infrastructure.
 */
function createSessionStore(db) {
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
      this.deleteStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
      this.sweepStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
      this.timer = setInterval(() => this.sweep(), 60 * 60 * 1000);
      if (this.timer.unref) this.timer.unref();
    }

    expiryFor(sess) {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 14 * 24 * 60 * 60 * 1000;
      return Date.now() + maxAge;
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
      this.set(sid, sess, callback);
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
