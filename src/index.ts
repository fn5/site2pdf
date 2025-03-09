import { Buffer } from "node:buffer";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

import puppeteer, { type Browser, type Page } from "puppeteer";
import pLimit from "p-limit";
import { PDFDocument } from "pdf-lib";
import chromeFinder from "chrome-finder";

function showHelp() {
	console.log(`
Usage: site2pdf-cli <main_url> [url_pattern]

Arguments:
  main_url         The main URL to generate PDF from
  url_pattern      (Optional) Regular expression pattern to match sub-links (default: ^main_url)
`);
}

type BrowserContext = {
	browser: Browser,
	page: Page,
};

async function useBrowserContext() {
	const browser = await puppeteer.launch({
		headless: true,
		executablePath: chromeFinder(),
	});
	const page = (await browser.pages())[0];
	return {
		browser,
		page
	};
}

export async function generatePDF(
	ctx: BrowserContext,
	url: string,
	urlPattern: RegExp = new RegExp(`^${url}`),
	concurrentLimit: number,
): Promise<Buffer> {
	const limit = pLimit(concurrentLimit);
	const crawledUrls = new Set<string>();
	const queue: string[] = [url];
	
	// Recursive crawl function
	const crawlPage = async (currentUrl: string) => {
		if (crawledUrls.has(currentUrl)) return;
		crawledUrls.add(currentUrl);
		
		const page = await ctx.browser.newPage();
		try {
			await page.goto(currentUrl, { waitUntil: 'networkidle0', timeout: 30000 });
			
			const subLinks = await page.evaluate((mainUrl) => {
				const links = Array.from(document.querySelectorAll("a"));
				return links.map(link => {
					try {
						const resolvedUrl = new URL(link.href, window.location.href).href;
						return resolvedUrl.startsWith(mainUrl) &&
							!resolvedUrl.includes("#") &&
							!resolvedUrl.includes("mailto:") &&
							!resolvedUrl.includes("tel:")
							? resolvedUrl
							: null;
					} catch {
						return null;
					}
				}).filter(Boolean) as string[];
			}, url);
			
			for (const link of subLinks) {
				const normalized = normalizeURL(link);
				if (!crawledUrls.has(normalized) && !queue.includes(normalized)) {
					queue.push(normalized);
				}
			}
		} finally {
			await page.close();
		}
	};

	// Process queue recursively
	while (queue.length > 0) {
		const currentUrl = queue.shift()!;
		await crawlPage(currentUrl);
	}

	const uniqueSubLinks = Array.from(crawledUrls);

	if (!uniqueSubLinks.includes(url)) {
		uniqueSubLinks.unshift(url);
	}

	const pdfDoc = await PDFDocument.create();

	const generatePDFForPage = async (link: string) => {
		console.log(`Processing ${link}`);
		const newPage = await ctx.browser.newPage();
		try {
			// Wait for all network activity to stop for at least 500ms
			await newPage.goto(link, {
				waitUntil: 'networkidle0',
				timeout: 30000
			});
			
			// Wait for any lazy-loaded content
			await newPage.waitForFunction(() => {
				// Wait for any pending dynamic content
				const initialHeight = document.body.scrollHeight;
				setTimeout(() => window.scrollBy(0, 1000), 100);
				return new Promise(resolve =>
					setTimeout(() => resolve(document.body.scrollHeight === initialHeight), 500)
				);
			}, { timeout: 10000 });
			
			// Set viewport for high resolution rendering
			await newPage.setViewport({
				width: 2480,
				height: 3508,
				deviceScaleFactor: 2
			});
			
			const pdfBytes = await newPage.pdf({
				format: "A3",
				preferCSSPageSize: true,
				omitBackground: false,
				scale: 1.5,
				printBackground: true,
				timeout: 60000
			});
			
			console.log(`Successfully generated PDF for ${link}`);
			return pdfBytes;
		} catch (error) {
			console.warn(`Skipping ${link}: ${error instanceof Error ? error.message : error}`);
			return null;
		} finally {
			await newPage.close();
		}
	};

	// Process all crawled pages with concurrency control
	const results = await Promise.allSettled(
		uniqueSubLinks.map(link =>
			limit(() => generatePDFForPage(link))
		)
	);
	// Filter out failed results and extract PDF buffers
	const pdfBytesArray = results
		.filter((result): result is PromiseFulfilledResult<Buffer> =>
			result.status === 'fulfilled' && result.value !== null
		)
		.map(result => result.value)
		.filter((buffer): buffer is Buffer => buffer !== null);

	for (const pdfBytes of pdfBytesArray) {
		const subPdfDoc = await PDFDocument.load(pdfBytes);
		const copiedPages = await pdfDoc.copyPages(
			subPdfDoc,
			subPdfDoc.getPageIndices(),
		);
		for (const page of copiedPages) {
			pdfDoc.addPage(page);
		}
	}

	const pdfBytes = await pdfDoc.save();
	const pdfBuffer = Buffer.from(pdfBytes);

	return pdfBuffer;
}

export function generateSlug(url: string): string {
	return url
		.replace(/https?:\/\//, "")
		.replace(/[^\w\s-]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/\./g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();
}

export function normalizeURL(url: string): string {
	const urlWithoutAnchor = url.split("#")[0];
	return urlWithoutAnchor.endsWith("/")
		? urlWithoutAnchor.slice(0, -1)
		: urlWithoutAnchor;
}

export async function main() {
	const mainURL = process.argv[2];
	const urlPattern = process.argv[3]
		? new RegExp(process.argv[3])
		: new RegExp(`^${mainURL}`);

	if (!mainURL) {
		showHelp();
		throw new Error("<main_url> is required");
	}

	console.log(
		`Generating PDF for ${mainURL} and sub-links matching ${urlPattern}`,
	);
	let ctx;
	try {
		ctx = await useBrowserContext();
		const pdfBuffer = await generatePDF(ctx, mainURL, urlPattern, cpus().length);
		const slug = generateSlug(mainURL);
		const outputDir = join(process.cwd(), "out");
		const outputPath = join(outputDir, `${slug}.pdf`);

		if (!existsSync(outputDir)) {
			mkdirSync(outputDir, { recursive: true });
		}

		writeFileSync(outputPath, new Uint8Array(pdfBuffer));
		console.log(`PDF saved to ${outputPath}`);
	} catch (error) {
		console.error("Error generating PDF:", error);
	} finally {
		ctx?.browser.close();
	}
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main();
}
