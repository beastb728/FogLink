# Needs Docker, Node 22 and Python 3.10+. Go runs inside Docker (server/go.sh).
.PHONY: up dev relay test test-relay test-sim test-android apk ab ml roads

up:            ## everything on http://localhost:8080 (relay + Redis + dashboard + phone client)
	docker compose up --build
relay:         ## build the relay binary into server/foglink-relay
	server/go.sh build -o foglink-relay .
dev: relay     ## relay on :8080 and the dashboard with live reload on :5173
	(FOGLINK_OBSERVER_TOKEN=dev ./server/foglink-relay & cd sim && npm install && npm run dev)
test: test-relay test-sim
test-relay:
	server/go.sh test -count=1 -v ./...
test-sim:
	cd sim && npm test
test-android:  ## Kotlin port checked against vectors from the JavaScript reference (needs the Android SDK)
	node sim/cli/vectors.mjs && cd android && ./gradlew testDebugUnitTest
apk:           ## android/app/build/outputs/apk/debug/app-debug.apk
	cd android && ./gradlew assembleDebug
ab:            ## with vs without FogLink, 20 seeds per row
	cd sim && node cli/ab.mjs --seeds 20
ml:            ## train + evaluate the braking model (synthetic drives unless DRIVES is set)
	cd ml && python3 -m foglink_ml.train $(if $(DRIVES),--drives $(DRIVES),)
roads:         ## re-download the carriageway lines from OpenStreetMap
	python3 data/fetch_osm.py --refresh
