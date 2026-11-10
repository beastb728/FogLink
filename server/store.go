package main

import (
	"context"
	"sync"
	"time"
)

// positionTTL is how long the relay remembers where a vehicle is. A phone
// reports about once a second; after a few silent seconds it is forgotten.
// Nothing is ever written to disk and there is no history: one latest
// position per anonymous ID, in memory, then gone.
const positionTTL = 5 * time.Second

// Store answers one question: which vehicles are behind this point on this
// carriageway? A carriageway ID names one direction of one road, and s is
// metres along it in the direction of travel, so "behind" is simply "smaller s".
type Store interface {
	Update(ctx context.Context, id, cw string, s float64) error
	// Behind returns the IDs with position in [s-rangeM, s) on cw.
	Behind(ctx context.Context, cw string, s, rangeM float64) ([]Target, error)
	Remove(ctx context.Context, id string) error
}

type Target struct {
	ID string
	S  float64
}

type memEntry struct {
	cw   string
	s    float64
	seen time.Time
}

type memStore struct {
	mu   sync.RWMutex
	byID map[string]memEntry
	byCW map[string]map[string]struct{}
	now  func() time.Time
}

func newMemStore() *memStore {
	return &memStore{byID: map[string]memEntry{}, byCW: map[string]map[string]struct{}{}, now: time.Now}
}

func (m *memStore) Update(_ context.Context, id, cw string, s float64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.byID[id]; ok && old.cw != cw {
		delete(m.byCW[old.cw], id)
	}
	m.byID[id] = memEntry{cw: cw, s: s, seen: m.now()}
	set := m.byCW[cw]
	if set == nil {
		set = map[string]struct{}{}
		m.byCW[cw] = set
	}
	set[id] = struct{}{}
	return nil
}

func (m *memStore) Behind(_ context.Context, cw string, s, rangeM float64) ([]Target, error) {
	cutoff := m.now().Add(-positionTTL)
	var out []Target
	var stale []string
	m.mu.RLock()
	for id := range m.byCW[cw] {
		e := m.byID[id]
		if e.seen.Before(cutoff) {
			stale = append(stale, id)
			continue
		}
		if e.s < s && e.s >= s-rangeM {
			out = append(out, Target{ID: id, S: e.s})
		}
	}
	m.mu.RUnlock()
	if len(stale) > 0 {
		m.mu.Lock()
		for _, id := range stale {
			if e, ok := m.byID[id]; ok && e.seen.Before(cutoff) {
				delete(m.byID, id)
				delete(m.byCW[e.cw], id)
			}
		}
		m.mu.Unlock()
	}
	return out, nil
}

func (m *memStore) Remove(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.byID[id]; ok {
		delete(m.byCW[e.cw], id)
		delete(m.byID, id)
	}
	return nil
}
