package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// redisStore keeps the same data as memStore in Redis, so several relay
// instances can share one view of the road:
//
//	fl:cw:<carriageway>  sorted set, member = vehicle ID, score = s
//	fl:v:<id>            the carriageway the vehicle is on, expiring after positionTTL
//
// Sorted-set members cannot expire on their own, so a member only counts while
// its fl:v key is alive and still names this carriageway; dead ones are removed
// when a lookup trips over them.
type redisStore struct{ rdb *redis.Client }

func newRedisStore(addr string) (*redisStore, error) {
	rdb := redis.NewClient(&redis.Options{Addr: addr})
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		return nil, err
	}
	return &redisStore{rdb: rdb}, nil
}

func (r *redisStore) Update(ctx context.Context, id, cw string, s float64) error {
	p := r.rdb.Pipeline()
	p.ZAdd(ctx, "fl:cw:"+cw, redis.Z{Score: s, Member: id})
	p.Set(ctx, "fl:v:"+id, cw, positionTTL)
	_, err := p.Exec(ctx)
	return err
}

func (r *redisStore) Behind(ctx context.Context, cw string, s, rangeM float64) ([]Target, error) {
	key := "fl:cw:" + cw
	zs, err := r.rdb.ZRangeByScoreWithScores(ctx, key, &redis.ZRangeBy{
		Min: strconv.FormatFloat(s-rangeM, 'f', 1, 64),
		Max: "(" + strconv.FormatFloat(s, 'f', 1, 64),
	}).Result()
	if err != nil || len(zs) == 0 {
		return nil, err
	}
	keys := make([]string, len(zs))
	for i, z := range zs {
		keys[i] = "fl:v:" + z.Member.(string)
	}
	alive, err := r.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	var out []Target
	var dead []any
	for i, z := range zs {
		if v, ok := alive[i].(string); ok && v == cw {
			out = append(out, Target{ID: z.Member.(string), S: z.Score})
		} else {
			dead = append(dead, z.Member)
		}
	}
	if len(dead) > 0 {
		r.rdb.ZRem(ctx, key, dead...)
	}
	return out, nil
}

func (r *redisStore) Remove(ctx context.Context, id string) error {
	return r.rdb.Del(ctx, "fl:v:"+id).Err()
}
