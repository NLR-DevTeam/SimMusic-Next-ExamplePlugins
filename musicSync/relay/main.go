// Command musicsync-relay is the relay of the "一起听" extension. A member creates a share, gets a link
// "<relay>/s/<id>" and hands it to others: they paste it into the extension, or open it in a browser, which
// gets the relay's own player page. Everyone in a share holds one state (the queue, the current song,
// playing or paused and where) that any of them may replace. The audio of a song is fetched from the
// member who brought it: an address is handed on with its request headers (and fetched through here for
// browsers, which cannot send those headers), a file is streamed through here while it is being uploaded.
// The share ends when its creator ends it or has been gone for a while.
//
//	POST   /api/sessions               { client, password } → { id, token }; with -key, the X-Sync-Key header
//	GET    /api/s/{id}                 { password }: whether the share asks for one
//	DELETE /api/s/{id}                 ends the share; the X-Sync-Token header carries the creator's token
//
// The rest needs the share's password, if it has one, in the X-Sync-Password header or the p parameter:
//
//	GET  /api/s/{id}/poll?client=&since=&web=   events after since, waiting up to 25 s; since -1 (or a sequence
//	                                            the relay does not know) answers at once with the current state
//	POST /api/s/{id}/state?client=              replaces the state with the body; announced as a "state" event
//	POST /api/s/{id}/resolve?client=            { key }: the audio of a song for a member's player
//	POST /api/s/{id}/answer?client=             { ticket, url, headers, lyrics } | { ticket, size, type, lyrics } |
//	                                            { ticket, data, type, final } | { ticket, error }
//	PUT  /api/s/{id}/files/{file}[?tail=start]  the upload of a file promised by an answer with a size; with tail,
//	                                            its end from start on, sent ahead (a browser reads the end first);
//	                                            with offset=n, the rest after n bytes of an upload that paused
//	GET  /api/s/{id}/files/{file}               the file, while it is still being uploaded too
//	GET  /api/s/{id}/audio?key=                 the audio of a song for a browser; byte ranges are honoured
//	GET  /api/s/{id}/cover?key=&size=&fallback= the cover picture of a song; size "large" for the play page's one;
//	                                            fallback=1 gives the placeholder for a song without one
//	GET  /api/s/{id}/lyrics?key=                { lrc }: the lyrics of a song, once a member has them
//	POST /api/s/{id}/lyrics                     { key, lrc }: the lyrics of a song, from a member that plays it
//	GET  /api/s/{id}/position                   { key, position, playing, speed, at }: where the creator is playing
//	POST /api/s/{id}/offer                      { key, size, type } → { file } | { exists }: a file sent before it is asked for
//	GET  /api/s/{id}/lyrics.lrc?key=            the lyrics as LRC text, waiting up to 4 s for a member to send them
//
// A song's key is "<client of the member who brought it>.<anything>"; that member is asked for the song with
// a "need" event { ticket, key, kind, large }, kind "audio" or "cover", and replies with an answer; a cover's
// answer says whether it is final. A member polling for the first time is announced with a "joined" event.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var web embed.FS

// placeholder is the picture of a song without a cover in the web player.
//
//go:embed web/sim/placeholder.png
var placeholder []byte

const (
	pollWait    = 25 * time.Second
	answerWait  = 30 * time.Second
	uploadWait  = 5 * time.Minute
	memberAlive = 45 * time.Second
	addressKept = 2 * time.Minute
	keptEvents  = 512
	keptFiles   = 48
	keptLyrics  = 256
	maxFile     = 2 << 30
	maxBody     = 4 << 20
)

type event struct {
	Seq  int64           `json:"seq"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
	to   string
}

type answer struct {
	Ticket  string            `json:"ticket"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Size    int64             `json:"size,omitempty"`
	Data    []byte            `json:"data,omitempty"`
	Type    string            `json:"type,omitempty"`
	Lyrics  string            `json:"lyrics,omitempty"`
	Final   bool              `json:"final,omitempty"`
	// The answer of the creator about where it is playing: the song, the position in seconds, the speed.
	Key      string  `json:"key,omitempty"`
	Position float64 `json:"position,omitempty"`
	Playing  bool    `json:"playing,omitempty"`
	Speed    float64 `json:"speed,omitempty"`
	Error    string  `json:"error,omitempty"`
}

// file is one upload, kept on disk; readers follow it while it grows.
type file struct {
	mu        sync.Mutex
	cond      *sync.Cond
	path      string
	kind      string
	size      int64
	written   int64
	uploading bool
	done      bool
	failed    bool
	created   time.Time
	// The end of the file, sent ahead of the rest: a browser reads the tags at the end of a file before
	// it plays, and would otherwise wait for the whole upload.
	tail      []byte
	tailStart int64
}

const maxTail = 1 << 20

func (f *file) fail() {
	f.mu.Lock()
	if !f.done {
		f.failed = true
	}
	f.cond.Broadcast()
	f.mu.Unlock()
}

type address struct {
	answer answer
	at     time.Time
}

type session struct {
	id, password, token, host string

	mu        sync.Mutex
	seq       int64
	events    []event
	wake      chan struct{}
	ended     bool
	state     json.RawMessage
	version   int64
	members   map[string]time.Time
	web       map[string]bool
	waiting   map[string]chan answer
	files     map[string]*file
	byKey     map[string]string // "audio\x00key" or "cover\x00key" → file id
	addresses map[string]address
	lyrics    map[string]string
}

type relay struct {
	key      string
	dir      string
	mu       sync.Mutex
	sessions map[string]*session
}

func randomID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, text string) {
	reply(w, status, map[string]string{"error": text})
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// push announces an event; the caller holds s.mu.
func (s *session) push(kind, to string, data any) {
	raw, _ := json.Marshal(data)
	s.seq++
	s.events = append(s.events, event{Seq: s.seq, Type: kind, Data: raw, to: to})
	if len(s.events) > keptEvents {
		s.events = append([]event(nil), s.events[len(s.events)-keptEvents:]...)
	}
	close(s.wake)
	s.wake = make(chan struct{})
}

func (s *session) alive(client string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.members[client]) < memberAlive
}

// end lets the share go with its files; whoever waits is woken and told.
func (r *relay) end(s *session) {
	r.mu.Lock()
	delete(r.sessions, s.id)
	r.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return
	}
	s.ended = true
	close(s.wake)
	for _, f := range s.files {
		f.fail()
		os.Remove(f.path)
	}
	s.files = map[string]*file{}
}

func (r *relay) create(w http.ResponseWriter, req *http.Request) {
	if r.key != "" && !same(req.Header.Get("X-Sync-Key"), r.key) {
		fail(w, http.StatusUnauthorized, "key")
		return
	}
	var body struct {
		Client   string `json:"client"`
		Password string `json:"password"`
	}
	if json.NewDecoder(io.LimitReader(req.Body, maxBody)).Decode(&body) != nil || body.Client == "" || strings.Contains(body.Client, ".") {
		fail(w, http.StatusBadRequest, "client")
		return
	}
	s := &session{id: randomID(8), password: body.Password, token: randomID(16), host: body.Client, wake: make(chan struct{}),
		members: map[string]time.Time{body.Client: time.Now()}, web: map[string]bool{}, waiting: map[string]chan answer{},
		files: map[string]*file{}, byKey: map[string]string{}, addresses: map[string]address{}, lyrics: map[string]string{}}
	r.mu.Lock()
	r.sessions[s.id] = s
	r.mu.Unlock()
	reply(w, http.StatusOK, map[string]string{"id": s.id, "token": s.token})
}

func (r *relay) find(id string) *session {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[id]
}

func (r *relay) info(w http.ResponseWriter, req *http.Request) {
	s := r.find(req.PathValue("id"))
	if s == nil {
		fail(w, http.StatusNotFound, "ended")
		return
	}
	reply(w, http.StatusOK, map[string]bool{"password": s.password != ""})
}

func (r *relay) remove(w http.ResponseWriter, req *http.Request) {
	s := r.find(req.PathValue("id"))
	if s == nil {
		fail(w, http.StatusNotFound, "ended")
		return
	}
	if !same(req.Header.Get("X-Sync-Token"), s.token) {
		fail(w, http.StatusForbidden, "token")
		return
	}
	r.end(s)
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

// member wraps a handler of a share: the share must still be there and the password right.
func (r *relay) member(handler func(http.ResponseWriter, *http.Request, *session)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		s := r.find(req.PathValue("id"))
		if s == nil {
			fail(w, http.StatusNotFound, "ended")
			return
		}
		password := req.Header.Get("X-Sync-Password")
		if password == "" {
			password = req.URL.Query().Get("p")
		}
		if s.password != "" && !same(password, s.password) {
			fail(w, http.StatusUnauthorized, "password")
			return
		}
		handler(w, req, s)
	}
}

func (r *relay) poll(w http.ResponseWriter, req *http.Request, s *session) {
	query := req.URL.Query()
	client := query.Get("client")
	since, err := strconv.ParseInt(query.Get("since"), 10, 64)
	if err != nil {
		since = -1
	}
	deadline := time.NewTimer(pollWait)
	defer deadline.Stop()
	for {
		s.mu.Lock()
		if s.ended {
			s.mu.Unlock()
			fail(w, http.StatusNotFound, "ended")
			return
		}
		// A member seen for the first time is announced: the creator answers with the whole state for it.
		if _, seen := s.members[client]; !seen {
			s.push("joined", "", map[string]string{"client": client})
		}
		s.members[client] = time.Now()
		s.web[client] = query.Get("web") == "1"
		members := 0
		for _, seen := range s.members {
			if time.Since(seen) < memberAlive {
				members++
			}
		}
		out := map[string]any{"seq": s.seq, "now": time.Now().UnixMilli(), "members": members, "events": []event{}}
		oldest := s.seq + 1
		if len(s.events) > 0 {
			oldest = s.events[0].Seq
		}
		// A new member, or one that missed events, starts from the state as it is.
		if since < 0 || since > s.seq || since < oldest-1 {
			if s.state != nil {
				out["state"] = s.state
			}
			s.mu.Unlock()
			reply(w, http.StatusOK, out)
			return
		}
		events := []event{}
		for _, e := range s.events {
			if e.Seq > since && (e.to == "" || e.to == client) {
				events = append(events, e)
			}
		}
		wake, seq := s.wake, s.seq
		s.mu.Unlock()
		if len(events) > 0 {
			out["events"] = events
			reply(w, http.StatusOK, out)
			return
		}
		select {
		case <-wake:
			// Events for others only move the sequence on.
			since = seq
		case <-deadline.C:
			// The time is that of the reply: members take their clock offset from it.
			out["now"] = time.Now().UnixMilli()
			reply(w, http.StatusOK, out)
			return
		case <-req.Context().Done():
			return
		}
	}
}

func (r *relay) setState(w http.ResponseWriter, req *http.Request, s *session) {
	body, err := io.ReadAll(io.LimitReader(req.Body, maxBody))
	if err != nil || !json.Valid(body) {
		fail(w, http.StatusBadRequest, "state")
		return
	}
	client := req.URL.Query().Get("client")
	s.mu.Lock()
	s.members[client] = time.Now()
	s.version++
	wrapped, _ := json.Marshal(map[string]any{"version": s.version, "by": client, "state": json.RawMessage(body)})
	s.state = wrapped
	s.push("state", "", json.RawMessage(wrapped))
	version := s.version
	s.mu.Unlock()
	reply(w, http.StatusOK, map[string]any{"version": version})
}

// ask has the member who brought the song answer for it.
func (r *relay) ask(req *http.Request, s *session, key, kind string, large bool) (answer, error) {
	origin, _, ok := strings.Cut(key, ".")
	if !ok {
		return answer{}, errors.New("gone")
	}
	return r.askMember(req, s, origin, map[string]any{"key": key, "kind": kind, "large": large})
}

// askMember sends one member a "need" event with need and waits for its answer.
func (r *relay) askMember(req *http.Request, s *session, member string, need map[string]any) (answer, error) {
	if !s.alive(member) {
		return answer{}, errors.New("gone")
	}
	id := randomID(12)
	need["ticket"] = id
	ch := make(chan answer, 1)
	s.mu.Lock()
	s.waiting[id] = ch
	s.push("need", member, need)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.waiting, id)
		s.mu.Unlock()
	}()
	select {
	case a := <-ch:
		if a.Error != "" {
			return a, errors.New(a.Error)
		}
		a.Ticket = id
		return a, nil
	case <-time.After(answerWait):
		return answer{}, errors.New("no answer")
	case <-req.Context().Done():
		return answer{}, req.Context().Err()
	}
}

// cached is the file kept for a song, unless it failed.
func (s *session) cached(kind, key string) (string, *file) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.byKey[kind+"\x00"+key]
	f := s.files[id]
	if f == nil {
		return "", nil
	}
	f.mu.Lock()
	failed := f.failed
	f.mu.Unlock()
	if failed {
		return "", nil
	}
	return id, f
}

// keep adds a file to the share, letting the oldest finished ones go.
func (s *session) keep(id, kind, key string, f *file) bool {
	f.cond = sync.NewCond(&f.mu)
	f.created = time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return false
	}
	s.files[id] = f
	s.byKey[kind+"\x00"+key] = id
	for len(s.files) > keptFiles {
		oldest := ""
		for name, candidate := range s.files {
			candidate.mu.Lock()
			finished := candidate.done || candidate.failed
			candidate.mu.Unlock()
			if finished && (oldest == "" || candidate.created.Before(s.files[oldest].created)) {
				oldest = name
			}
		}
		if oldest == "" {
			break
		}
		os.Remove(s.files[oldest].path)
		delete(s.files, oldest)
	}
	return true
}

func (s *session) learnLyrics(key, lrc string) {
	if lrc == "" {
		return
	}
	s.mu.Lock()
	if len(s.lyrics) >= keptLyrics {
		s.lyrics = map[string]string{}
	}
	s.lyrics[key] = lrc
	s.mu.Unlock()
}

// audio is where the song's audio is: an address with its headers, or a file of the share.
func (r *relay) audio(req *http.Request, s *session, key string) (answer, string, *file, error) {
	if id, f := s.cached("audio", key); f != nil {
		return answer{}, id, f, nil
	}
	s.mu.Lock()
	kept, ok := s.addresses[key]
	s.mu.Unlock()
	if ok && time.Since(kept.at) < addressKept {
		return kept.answer, "", nil, nil
	}
	a, err := r.ask(req, s, key, "audio", false)
	if err != nil {
		return a, "", nil, err
	}
	s.learnLyrics(key, a.Lyrics)
	switch {
	case a.URL != "":
		s.mu.Lock()
		s.addresses[key] = address{a, time.Now()}
		s.mu.Unlock()
		return a, "", nil, nil
	case a.Size > 0 && a.Size <= maxFile:
		id, f, err := r.fileFor(s, key, a.Ticket, a.Size, a.Type)
		return a, id, f, err
	}
	return a, "", nil, errors.New("no audio")
}

func (r *relay) resolve(w http.ResponseWriter, req *http.Request, s *session) {
	var body struct {
		Key string `json:"key"`
	}
	if json.NewDecoder(io.LimitReader(req.Body, maxBody)).Decode(&body) != nil || body.Key == "" {
		fail(w, http.StatusBadRequest, "key")
		return
	}
	a, id, _, err := r.audio(req, s, body.Key)
	if err != nil {
		fail(w, http.StatusBadGateway, "audio")
		return
	}
	s.mu.Lock()
	lyrics := s.lyrics[body.Key]
	s.mu.Unlock()
	if id != "" {
		reply(w, http.StatusOK, map[string]any{"file": id, "lyrics": lyrics})
		return
	}
	reply(w, http.StatusOK, map[string]any{"url": a.URL, "headers": a.Headers, "lyrics": lyrics})
}

func (r *relay) answer(w http.ResponseWriter, req *http.Request, s *session) {
	var a answer
	if json.NewDecoder(io.LimitReader(req.Body, maxBody*4)).Decode(&a) != nil {
		fail(w, http.StatusBadRequest, "answer")
		return
	}
	s.mu.Lock()
	ch := s.waiting[a.Ticket]
	delete(s.waiting, a.Ticket)
	s.mu.Unlock()
	if ch == nil {
		fail(w, http.StatusGone, "ticket")
		return
	}
	ch <- a
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

func (r *relay) upload(w http.ResponseWriter, req *http.Request, s *session) {
	s.mu.Lock()
	f := s.files[req.PathValue("file")]
	s.mu.Unlock()
	if f == nil {
		fail(w, http.StatusNotFound, "file")
		return
	}
	// ?tail=start: the end of the file from start on, ahead of the upload of the whole.
	if value := req.URL.Query().Get("tail"); value != "" {
		start, err := strconv.ParseInt(value, 10, 64)
		if err != nil || start < 0 || start >= f.size || f.size-start > maxTail {
			fail(w, http.StatusBadRequest, "tail")
			return
		}
		tail, err := io.ReadAll(io.LimitReader(req.Body, f.size-start))
		if err != nil || int64(len(tail)) != f.size-start {
			fail(w, http.StatusBadRequest, "tail")
			return
		}
		f.mu.Lock()
		f.tail, f.tailStart = tail, start
		f.cond.Broadcast()
		f.mu.Unlock()
		reply(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	// ?offset=n continues an upload that stopped after n bytes; a wrong offset is answered with where it stopped.
	offset, _ := strconv.ParseInt(req.URL.Query().Get("offset"), 10, 64)
	f.mu.Lock()
	if f.uploading || f.failed || f.done || offset != f.written {
		written := f.written
		f.mu.Unlock()
		reply(w, http.StatusConflict, map[string]int64{"written": written})
		return
	}
	f.uploading = true
	f.mu.Unlock()
	// An upload that stops before the end only pauses: the member who brought the song continues it later.
	pause := func() {
		f.mu.Lock()
		f.uploading = false
		f.cond.Broadcast()
		f.mu.Unlock()
	}
	out, err := os.OpenFile(f.path, os.O_WRONLY, 0o600)
	if err == nil {
		_, err = out.Seek(offset, io.SeekStart)
	}
	if err != nil {
		f.fail()
		fail(w, http.StatusInternalServerError, "disk")
		return
	}
	defer out.Close()
	buf := make([]byte, 256<<10)
	body := io.LimitReader(req.Body, f.size-offset)
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			if _, err := out.Write(buf[:n]); err != nil {
				f.fail()
				fail(w, http.StatusInternalServerError, "disk")
				return
			}
			f.mu.Lock()
			f.written += int64(n)
			f.cond.Broadcast()
			f.mu.Unlock()
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			pause()
			return
		}
	}
	f.mu.Lock()
	complete, written := f.written == f.size, f.written
	f.done, f.uploading = complete, false
	f.cond.Broadcast()
	f.mu.Unlock()
	if !complete {
		reply(w, http.StatusAccepted, map[string]int64{"written": written})
		return
	}
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

// byteRange reads a single "bytes=a-b" range of a file of size bytes.
func byteRange(header string, size int64) (int64, int64, bool) {
	spec, ok := strings.CutPrefix(header, "bytes=")
	if !ok || strings.Contains(spec, ",") {
		return 0, size - 1, false
	}
	first, last, _ := strings.Cut(spec, "-")
	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, size - 1, false
	}
	end := size - 1
	if value, err := strconv.ParseInt(last, 10, 64); err == nil && value >= start && value < size {
		end = value
	}
	return start, end, true
}

// serve sends a file, following an upload still under way; a byte range asked for is honoured.
func serve(w http.ResponseWriter, req *http.Request, f *file) {
	in, err := os.Open(f.path)
	if err != nil {
		fail(w, http.StatusNotFound, "file")
		return
	}
	defer in.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-req.Context().Done():
			f.mu.Lock()
			f.cond.Broadcast()
			f.mu.Unlock()
		case <-done:
		}
	}()
	if f.kind != "" {
		w.Header().Set("Content-Type", f.kind)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	start, end, partial := byteRange(req.Header.Get("Range"), f.size)
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	if partial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, f.size))
		w.WriteHeader(http.StatusPartialContent)
	}
	buf := make([]byte, 256<<10)
	for at := start; at <= end; {
		f.mu.Lock()
		for f.written <= at && (f.tail == nil || at < f.tailStart) && !f.failed && req.Context().Err() == nil {
			f.cond.Wait()
		}
		available, failed, tail, tailStart := f.written, f.failed, f.tail, f.tailStart
		f.mu.Unlock()
		if req.Context().Err() != nil {
			return
		}
		if available <= at && tail != nil && at >= tailStart {
			// Not uploaded in order yet, but sent ahead.
			n, _ := w.Write(tail[at-tailStart : min(int64(len(tail)), end+1-tailStart)])
			at += int64(n)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			continue
		}
		if failed && available <= at {
			panic(http.ErrAbortHandler)
		}
		n, err := in.ReadAt(buf[:min(int64(len(buf)), available-at, end+1-at)], at)
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return
			}
			at += int64(n)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if err != nil && err != io.EOF {
			panic(http.ErrAbortHandler)
		}
	}
}

func (r *relay) download(w http.ResponseWriter, req *http.Request, s *session) {
	s.mu.Lock()
	f := s.files[req.PathValue("file")]
	s.mu.Unlock()
	if f == nil {
		fail(w, http.StatusNotFound, "file")
		return
	}
	serve(w, req, f)
}

var forwarded = []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "Etag"}

// listen is the audio for a browser: a file of the share, or the address fetched with its headers.
func (r *relay) listen(w http.ResponseWriter, req *http.Request, s *session) {
	a, _, f, err := r.audio(req, s, req.URL.Query().Get("key"))
	if err != nil {
		fail(w, http.StatusBadGateway, "audio")
		return
	}
	if f != nil {
		serve(w, req, f)
		return
	}
	upstream, err := http.NewRequestWithContext(req.Context(), http.MethodGet, a.URL, nil)
	if err != nil {
		fail(w, http.StatusBadGateway, "audio")
		return
	}
	for name, value := range a.Headers {
		upstream.Header.Set(name, value)
	}
	if value := req.Header.Get("Range"); value != "" {
		upstream.Header.Set("Range", value)
	}
	resp, err := http.DefaultClient.Do(upstream)
	if err != nil {
		fail(w, http.StatusBadGateway, "audio")
		return
	}
	defer resp.Body.Close()
	for _, name := range forwarded {
		if value := resp.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// cover is the small picture of a song, or with size=large the one of a play page. The member who brought
// the song knows the large one once the song is open there; a picture given before that is sent but not kept.
func (r *relay) cover(w http.ResponseWriter, req *http.Request, s *session) {
	key, large := req.URL.Query().Get("key"), req.URL.Query().Get("size") == "large"
	kind := "cover"
	if large {
		kind = "large"
	}
	if _, f := s.cached(kind, key); f != nil {
		w.Header().Set("Cache-Control", "max-age=86400")
		serve(w, req, f)
		return
	}
	a, err := r.ask(req, s, key, "cover", large)
	if err != nil || len(a.Data) == 0 {
		// The web player asks with fallback=1: a song without a cover shows the placeholder there.
		if req.URL.Query().Get("fallback") == "1" {
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(placeholder)
			return
		}
		fail(w, http.StatusNotFound, "cover")
		return
	}
	if !a.Final {
		if a.Type != "" {
			w.Header().Set("Content-Type", a.Type)
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Write(a.Data)
		return
	}
	out, err := os.CreateTemp(r.dir, "cover-*")
	if err != nil {
		fail(w, http.StatusInternalServerError, "disk")
		return
	}
	_, err = out.Write(a.Data)
	out.Close()
	size := int64(len(a.Data))
	f := &file{path: out.Name(), kind: a.Type, size: size, written: size, uploading: true, done: true}
	if err != nil || !s.keep(randomID(12), kind, key, f) {
		os.Remove(f.path)
		fail(w, http.StatusInternalServerError, "disk")
		return
	}
	w.Header().Set("Cache-Control", "max-age=86400")
	serve(w, req, f)
}

// position is where the creator is playing, for a member that has just opened a song: { key, position, playing,
// speed, at }, at being the relay's time of the answer in milliseconds. The creator answers once its own song is open.
func (r *relay) position(w http.ResponseWriter, req *http.Request, s *session) {
	a, err := r.askMember(req, s, s.host, map[string]any{"kind": "position"})
	if err != nil {
		fail(w, http.StatusBadGateway, "position")
		return
	}
	reply(w, http.StatusOK, map[string]any{"key": a.Key, "position": a.Position, "playing": a.Playing, "speed": a.Speed, "at": time.Now().UnixMilli()})
}

// offer is the member who brought a song sending its file before anyone asks for it: { key, size, type } →
// { file } to upload to, or { exists } when the share has it already.
func (r *relay) offer(w http.ResponseWriter, req *http.Request, s *session) {
	var body struct {
		Key  string `json:"key"`
		Size int64  `json:"size"`
		Type string `json:"type"`
	}
	if json.NewDecoder(io.LimitReader(req.Body, maxBody)).Decode(&body) != nil || body.Key == "" || body.Size <= 0 || body.Size > maxFile {
		fail(w, http.StatusBadRequest, "offer")
		return
	}
	id, _, err := r.fileFor(s, body.Key, randomID(12), body.Size, body.Type)
	if err != nil {
		fail(w, http.StatusInternalServerError, "file")
		return
	}
	reply(w, http.StatusOK, map[string]string{"file": id})
}

// fileFor is the one file of a song: the one the share has (an upload to id then goes to it as well), or a new
// one under id. Two members' requests, or a request and an offer crossing, never make two.
func (r *relay) fileFor(s *session, key, id string, size int64, kind string) (string, *file, error) {
	s.mu.Lock()
	if existing := s.files[s.byKey["audio\x00"+key]]; existing != nil {
		existing.mu.Lock()
		failed := existing.failed
		existing.mu.Unlock()
		if !failed {
			name := s.byKey["audio\x00"+key]
			s.files[id] = existing
			s.mu.Unlock()
			return name, existing, nil
		}
	}
	s.mu.Unlock()
	out, err := os.CreateTemp(r.dir, "audio-*")
	if err != nil {
		return "", nil, err
	}
	out.Close()
	f := &file{path: out.Name(), size: size, kind: kind}
	if !s.keep(id, "audio", key, f) {
		os.Remove(f.path)
		return "", nil, errors.New("ended")
	}
	expectUpload(f)
	return id, f, nil
}

// expectUpload fails the readers of a file whose upload has not begun in time, instead of holding them. The
// member who brought it sends one file at a time, so a file may well wait its turn for a few minutes.
func expectUpload(f *file) {
	time.AfterFunc(uploadWait, func() {
		f.mu.Lock()
		started := f.uploading
		f.mu.Unlock()
		if !started {
			f.fail()
		}
	})
}

// lyricsFile is the lyrics of a song as LRC text, waiting a while for a member that plays it to send them:
// a member's player asks for it after it has started the audio.
func (r *relay) lyricsFile(w http.ResponseWriter, req *http.Request, s *session) {
	key := req.URL.Query().Get("key")
	deadline := time.Now().Add(4 * time.Second)
	for {
		s.mu.Lock()
		lrc, ended := s.lyrics[key], s.ended
		s.mu.Unlock()
		if lrc != "" || ended || time.Now().After(deadline) || req.Context().Err() != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Write([]byte(lrc))
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (r *relay) readLyrics(w http.ResponseWriter, req *http.Request, s *session) {
	s.mu.Lock()
	lrc := s.lyrics[req.URL.Query().Get("key")]
	s.mu.Unlock()
	reply(w, http.StatusOK, map[string]string{"lrc": lrc})
}

func (r *relay) writeLyrics(w http.ResponseWriter, req *http.Request, s *session) {
	var body struct {
		Key string `json:"key"`
		LRC string `json:"lrc"`
	}
	if json.NewDecoder(io.LimitReader(req.Body, maxBody)).Decode(&body) != nil || body.Key == "" {
		fail(w, http.StatusBadRequest, "lyrics")
		return
	}
	s.learnLyrics(body.Key, body.LRC)
	reply(w, http.StatusOK, map[string]bool{"ok": true})
}

// sweep ends the shares whose creator has been gone for a while.
func (r *relay) sweep() {
	for range time.Tick(10 * time.Second) {
		r.mu.Lock()
		var gone []*session
		for _, s := range r.sessions {
			if !s.alive(s.host) {
				gone = append(gone, s)
			}
		}
		r.mu.Unlock()
		for _, s := range gone {
			r.end(s)
		}
	}
}

func main() {
	addr := flag.String("addr", ":8686", "address to listen on")
	key := flag.String("key", "", "key needed to create shares; empty lets everyone create them")
	flag.Parse()
	dir, err := os.MkdirTemp("", "musicsync-relay-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	r := &relay{key: *key, dir: dir, sessions: map[string]*session{}}
	go r.sweep()
	page, _ := fs.Sub(web, "web")
	index, _ := fs.ReadFile(page, "index.html")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions", r.create)
	mux.HandleFunc("GET /api/s/{id}", r.info)
	mux.HandleFunc("DELETE /api/s/{id}", r.remove)
	mux.HandleFunc("GET /api/s/{id}/poll", r.member(r.poll))
	mux.HandleFunc("POST /api/s/{id}/state", r.member(r.setState))
	mux.HandleFunc("POST /api/s/{id}/resolve", r.member(r.resolve))
	mux.HandleFunc("POST /api/s/{id}/answer", r.member(r.answer))
	mux.HandleFunc("PUT /api/s/{id}/files/{file}", r.member(r.upload))
	mux.HandleFunc("GET /api/s/{id}/files/{file}", r.member(r.download))
	mux.HandleFunc("GET /api/s/{id}/audio", r.member(r.listen))
	mux.HandleFunc("GET /api/s/{id}/cover", r.member(r.cover))
	mux.HandleFunc("GET /api/s/{id}/lyrics", r.member(r.readLyrics))
	mux.HandleFunc("GET /api/s/{id}/position", r.member(r.position))
	mux.HandleFunc("POST /api/s/{id}/offer", r.member(r.offer))
	mux.HandleFunc("GET /api/s/{id}/lyrics.lrc", r.member(r.lyricsFile))
	mux.HandleFunc("POST /api/s/{id}/lyrics", r.member(r.writeLyrics))
	// The page and its files are always checked with the relay: one updated is not left running from a cache.
	mux.HandleFunc("GET /s/{id}", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})
	assets := http.StripPrefix("/s/assets/", http.FileServerFS(page))
	mux.HandleFunc("GET /s/assets/", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		assets.ServeHTTP(w, req)
	})
	log.Printf("musicsync relay listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
