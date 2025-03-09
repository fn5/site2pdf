import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import fs from 'fs-extra';
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
	urlPattern: RegExp,
	concurrentLimit: number,
	options?: { separate?: boolean }
): Promise<Buffer | Array<{ url: string, buffer: Buffer }>> {
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
			
			const subLinks = await page.evaluate((mainUrl, pattern) => {
				const links = Array.from(document.querySelectorAll("a"));
				return links.map(link => {
					try {
						const resolvedUrl = new URL(link.href, window.location.href).href;
						return !resolvedUrl.includes("#") &&
							!resolvedUrl.includes("mailto:") &&
							!resolvedUrl.includes("tel:") &&
							new RegExp(pattern).test(resolvedUrl)
							? resolvedUrl
							: null;
					} catch {
						return null;
					}
				}).filter(Boolean) as string[];
			}, url, urlPattern.source);
			
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
			
			// Set viewport for maximum resolution rendering
			await newPage.setViewport({
				width: 2480,
				height: 3508,
				deviceScaleFactor: 4
			});

			// Wait for all images to load completely
			await newPage.evaluate(() => {
				return Promise.all(
					Array.from(document.images)
						.filter(img => !img.complete)
						.map(img => new Promise(resolve => {
							img.onload = img.onerror = resolve;
						}))
				);
			});

			// Ensure high-quality image rendering
			await newPage.evaluate(() => {
				const style = document.createElement('style');
				style.textContent = `
					img {
						image-rendering: -webkit-optimize-contrast;
						image-rendering: crisp-edges;
						-ms-interpolation-mode: nearest-neighbor;
					}
				`;
				document.head.appendChild(style);
			});
			
			const pdfBytes = await newPage.pdf({
				format: "A3",
				preferCSSPageSize: true,
				omitBackground: false,
				scale: 1,
				printBackground: true,
				timeout: 60000
			});
			
			console.log(`Successfully generated PDF for ${link}`);
			return { url: link, buffer: pdfBytes };
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

	// Filter out failed results and extract PDF buffers with their URLs
	const pdfResults = results
		.filter((result): result is PromiseFulfilledResult<{ url: string, buffer: Buffer } | null> =>
			result.status === 'fulfilled'
		)
		.map(result => result.value)
		.filter((result): result is { url: string, buffer: Buffer } => result !== null);

	if (pdfResults.length === 0) {
		throw new Error("No PDFs were generated successfully");
	}

	// If separate option is not used, combine all PDFs
	if (!options?.separate) {
		const pdfDoc = await PDFDocument.create();
		for (const { buffer } of pdfResults) {
			const subPdfDoc = await PDFDocument.load(buffer);
			const copiedPages = await pdfDoc.copyPages(
				subPdfDoc,
				subPdfDoc.getPageIndices(),
			);
			for (const page of copiedPages) {
				pdfDoc.addPage(page);
			}
		}
		const pdfBytes = await pdfDoc.save();
		return Buffer.from(pdfBytes);
	}

	// Return array of results for separate PDFs
	return pdfResults;
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


interface Options {
  separate?: boolean;
  outputPath: string;
}

export async function main(mainURL: string, urlPattern?: string | RegExp, options: Options = { outputPath: './out' }) {

	if (!mainURL) {
		showHelp();
		throw new Error("<main_url> is required");
	}

	// Ensure urlPattern has a default value if not provided
	const pattern = urlPattern || new RegExp(`^${mainURL}`);

	console.log(
		`Generating PDF for ${mainURL} and sub-links matching ${urlPattern}`,
	);
	let ctx;
	try {
		ctx = await useBrowserContext();
		const result = await generatePDF(
			ctx,
			mainURL,
			pattern instanceof RegExp ? pattern : new RegExp(pattern),
			cpus().length,
			{ separate: options.separate }
		);

		const outputDir = join(options.outputPath);
		await fs.ensureDir(outputDir);

		if (Array.isArray(result)) {
			// Handle separate PDFs case
			for (const { url, buffer } of result) {
				const slug = generateSlug(url);
				const outputPath = join(outputDir, `${slug}.pdf`);
				await fs.writeFile(outputPath, buffer);
				console.log(`PDF saved to ${outputPath}`);
			}
		} else {
			// Handle single combined PDF case
			const slug = generateSlug(mainURL);
			const outputPath = join(outputDir, `${slug}.pdf`);
			await fs.writeFile(outputPath, result);
			console.log(`PDF saved to ${outputPath}`);
		}
	} catch (error) {
		console.error("Error generating PDF:", error);
	} finally {
		ctx?.browser.close();
	}
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	// @ts-ignore - CLI args are handled in bin/site2pdf.js
	main();
}
