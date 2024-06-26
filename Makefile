.DEFAULT_GOAL := install

install:
	npm install
	npx husky install
	npx playwright install
	chmod +x ./tests/shouldPass.sh
	chmod +x ./tests/shouldFail.sh

killautospec:
	pkill -f index.js || true

clean:
	rm -rf trajectories
	
realworld:
	URL="https://demo.realworld.io/" node index

todomvc:
	URL="https://todomvc.com/examples/react/dist/" node index