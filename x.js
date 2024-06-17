import dotenv from "dotenv";
import { chromium } from "playwright";
import { z } from "zod";
import { actionSchema } from "./schemas.js";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { sleep } from "openai/core.js";

dotenv.config();

const model = openai("gpt-4o");

async function captureAccessibilityTrees(browser, startUrl) {
    const page = await browser.newPage();

    const visitedUrls = new Set();
    const accessibilityTrees = [];

    async function visitPage(url) {
        if (visitedUrls.has(url) || !url.includes(startUrl)) {
            return;
        }

        visitedUrls.add(url);

        try {
            await page.goto(url);
            const accessibilityTree = await page.accessibility.snapshot();
            accessibilityTrees.push({ url, accessibilityTree });

            // Find all link elements on the page
            const links = await page.$$eval("a[href]", (links) =>
                links.map((link) => link.href),
            );

            // Visit each linked page
            for (const link of links) {
                if (!visitedUrls.has(link)) {
                    await visitPage(link);
                }
            }
        } catch (error) {
            console.error(`Failed to visit ${url}:`, error);
        }
    }

    await visitPage(startUrl);

    return accessibilityTrees;
}

async function generateTestSpecs(accessibilityTrees) {
    const testSpecs = [];

    for (const { url, accessibilityTree } of accessibilityTrees) {
        const prompt = `
        Generate test specifications for the following web page accessibility tree:

        URL: ${url}
        Accessibility Tree:
        ${JSON.stringify(accessibilityTree, null, 2)}

        Describe the behaviour the webpages accessiblity tree is likely to support.
        
        - Provide clear and actionable test cases to test that behaviour.

        For example: User should be able to create todo-item.
        `;

        const schema = z.object({
            specs: z.array(z.string()),
            webpage_behaviour_description: z.string(),
        });

        const result = await generateObject({ schema, prompt, model });
        testSpecs.push({ url, specs: result.object.specs });
    }

    return testSpecs;
}

async function executeAction(page, action) {
    console.log("executing action: ", JSON.stringify(action, null, 2));
    try {
        switch (action.actionType) {
            case "hoverOver":
                await page
                    .getByRole(
                        action.ariaSelector.role,
                        action.ariaSelector.ariaOptions,
                    )
                    .hover();
                break;
            case "clickOn":
                await page
                    .getByRole(
                        action.ariaSelector.role,
                        action.ariaSelector.ariaOptions,
                    )
                    .click();
                break;
            case "doubleClickOn":
                await page
                    .getByRole(
                        action.ariaSelector.role,
                        action.ariaSelector.ariaOptions,
                    )
                    .dblclick();
                break;
            case "keyboardInputString":
                await page
                    .getByRole(
                        action.ariaSelector.role,
                        action.ariaSelector.ariaOptions,
                    )
                    .fill(action.string);
                break;
            case "keyboardInputSingleKey":
                await page
                    .getByRole(
                        action.ariaSelector.role,
                        action.ariaSelector.ariaOptions,
                    )
                    .press(action.key);
                break;
            case "scroll":
                await page.mouse.wheel(action.deltaX, action.deltaY);
                break;
            case "hardWait":
                await page.waitForTimeout(action.milliseconds);
                break;
            case "navigate":
                await page.goto(action.url);
                break;
            case "markSpecAsPassed":
                return { complete: true, result: action };
            case "markAsFailed":
                return { complete: true, result: action };
            default:
                throw new Error(`Unknown action: ${action.action}`);
        }
        await page.waitForTimeout(50);
        return { complete: false, result: null };
    } catch (error) {
        console.log(error);
        console.error(
            "Error executing action:",
            JSON.stringify(action, null, 2),
            error,
        );
        return { error, success: false };
    }
}

async function executeSpec(browser, { url, spec }) {
    console.log("executing spec", { url, spec });
    const systemPrompt = `
        You are a test-automation agent. You can execute tests by driving a playwright browser via the described actions API.

        You are to execute tasks for the following test spec: ${spec}

        You should only respond with via the action object in order to drive your playwright test browser and complete the test.

        You should use as few steps as possible to complete the test.

        After each step you'll receive the current url and the new Accessibility Tree.

        You will judge if the test has passed or failed based on the contents of the incoming Accessibilty Tree and URL.

        The user messages will be in the format:
            URL: <url>
            Accessiblity Tree: <tree>

        Here is an example of an action schema response: 
        {
          action: {
              actionType: 'keyboardInputString',
              ariaSelector: { 
                role: 'textbox',
                ariaOptions: { name: 'New Todo Input' }
              },
              string: 'Test Todo'
          },
        }
        `;

    const schema = z.object({
        action: actionSchema,
    });

    const page = await browser.newPage();
    await page.goto(url);

    let stepCount = 0;

    while (true) {
        if (stepCount > 10) {
            console.log("max steps exceeded");
            return;
        }

        const tree = await page.accessibility.snapshot();
        const url = await page.url();

        const prompt = `
            URL: ${url}
            Accessibility tree: ${JSON.stringify(tree, null, 2)}
        `;
        const result = await generateObject({
            model,
            prompt,
            schema,
            system: systemPrompt,
            mode: "json",
        });

        const actionResult = await executeAction(page, result.object.action);

        if (actionResult.complete) {
            return;
        }

        await sleep(500);
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext();
    const startUrl = "https://todomvc.com/examples/react/dist/#/";
    // const trees = await captureAccessibilityTrees(browserContext, startUrl);
    // console.log(trees.map((t) => t.url));
    // const specs = await generateTestSpecs(trees);
    //
    // console.log(JSON.stringify(specs, null, 2));
    const pageSpecs = [
        {
            url: "https://todomvc.com/examples/react/dist/#/",
            specs: [
                "User should be able to see a heading element with the name 'todos' at level 1.",
                "User should be able to focus on a textbox with the name 'New Todo Input'.",
                "User should be able to see a static text element with the name 'New Todo Input'.",
                "User should be able to see a static text element with the instruction 'Double-click to edit a todo'.",
                "User should be able to see a static text element with the name 'Created by the TodoMVC Team'.",
                "User should be able to see a static text element with the name 'Part of'.",
                "User should be able to see a link with the name 'TodoMVC'.",
            ],
        },
    ];
    await executeSpec(browser, {
        url: pageSpecs[0].url,
        spec: "User should be able to create a TODO item",
    });
})();
