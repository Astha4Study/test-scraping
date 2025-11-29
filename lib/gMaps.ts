import puppeteer, { Browser, Page } from "puppeteer-core";
import path from "path";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { GoogleGenAI } from "@google/genai";
import slug from "slug";

const prisma = new PrismaClient();

export default class GMaps {
    private browser: Browser | null = null;
    private page: Page | null = null;

    constructor() {}

    public async initBrowser(): Promise<Browser> {
        if (this.browser) return this.browser;
        this.browser = await puppeteer.launch({
            executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
            userDataDir: path.join(__dirname, "../", "userData"),
            headless: false,
            defaultViewport: { width: 1920, height: 1080 },
            args: [
                '--disable-blink-features="AutomationControlled"',
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--lang=en-US",
                // "--disable-background-networking",
                // "--disable-gpu", //
            ],
            // ignoreDefaultArgs: ["--enable-automation"],
        });
        return this.browser;
    }

    private async repeatClickUntilSuccess(page: Page, element: any, maxAttempts: number = 10): Promise<boolean> {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await element.click();
                return true;
            } catch (error) {
                // Fallback: Try native DOM click if Puppeteer click fails
                try {
                    await element.evaluate((el: any) => el.scrollIntoView({ behavior: "instant", block: "center" }));
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    await page.evaluate((el: any) => el.click(), element);
                    return true;
                } catch (e) {
                    // Ignore fallback error and retry loop
                }

                if (attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        }
        this.log(`❌ Gagal click setelah ${maxAttempts} attempts`);
        return false;
    }

    private async extractBasicInfo(page: Page, selector: string): Promise<{ nama: string; alamat: string }> {
        const nama = await page.$eval(`${selector} h1`, (el) => el.textContent?.trim() || "");
        const alamat = await page.$eval(`${selector} div.Io6YTe`, (el) => el.textContent?.trim() || "");

        return { nama, alamat };
    }

    private async extractReviews(selector: string): Promise<{ rating: string; ulasans: any[] }> {
        if (!this.page) return { rating: "", ulasans: [] };

        let rating = "";
        const ulasans: any[] = [];

        try {
            // 1. Tunggu tombol Reviews muncul + klik sekali saja
            const reviewBtn = await this.page.waitForSelector('button[aria-label*="Reviews "]', {
                visible: true,
                timeout: 5000,
            });
            await reviewBtn?.click();
            await this.page.waitForNetworkIdle({ concurrency: 7 });
            // 2. Tunggu kontainer review
            await this.page.waitForSelector("div[data-review-id][jslog]", { visible: true });

            // 3. Ambil rating sekali saja
            rating = await this.page.$eval("div.fontDisplayLarge", (el) => el.textContent?.trim() ?? "");

            // 4a. Tunggu list ter-update

            await this.page.waitForFunction(() => document.querySelectorAll("div[data-review-id][jslog]").length > 0, { timeout: 5000 });
            // 4. Scroll + ekstrak 3 "batch"
            for (let batch = 0; batch < 3; batch++) {
                // 4b. Ekstrak semua review yang belum diproses dalam 1 evaluate
                const newData = await this.page.$$eval("div[data-review-id][jslog]", async (divs) => {
                    const out: any[] = [];
                    for await (const d of divs) {
                        if ((d as any)._done) continue;
                        (d as any)._done = true;

                        const expandBtn = d.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
                        if (expandBtn) expandBtn.click();

                        const nama = (d.querySelector(".d4r55") as HTMLElement)?.innerText?.trim() || null;
                        const ulasan = (d.querySelector(".MyEned span") as HTMLElement)?.innerText?.trim() || null;
                        const tanggal = (d.querySelector(".rsqaWe") as HTMLElement)?.innerText?.trim() || null;
                        if (nama || ulasan) out.push({ nama, ulasan, tanggal });
                    }
                    return out;
                });

                ulasans.push(...newData);

                // 4c. Scroll ke elemen paling bawah (trigger lazy-load)
                await this.page.evaluate(() => {
                    const last = document.querySelector("div.m6QErb:nth-child(3) > div:last-child");
                    last?.scrollIntoView({ behavior: "instant", block: "start" });
                });
                await this.page.waitForNetworkIdle({ concurrency: 7 });
            }
        } catch (err) {
            this.log(`❌ Gagal memproses ulasan: ${err}`);
            throw err;
        }
        return { rating, ulasans };
    }

    private async generateAIContent(nama: string, alamat: string, ulasans: any[], geminiApiKey?: string): Promise<{ harga: string; deskripsi: string }> {
        let harga: string = "";
        let deskripsi: string = "";

        while (true) {
            try {
                const ai = new GoogleGenAI({
                    apiKey: geminiApiKey || process.env.GEMINI_API_KEY,
                });
                const config = { responseMimeType: "text/plain" };
                const model = "gemini-2.5-flash-preview-05-20";
                const hargaContents = [
                    {
                        role: "user",
                        parts: [
                            {
                                text: `Berdasarkan nama tempat "${nama}" dan review berikut: ${ulasans
                                    .map((u) => u.ulasan)
                                    .join(" ")}. Jika ini adalah tempat wisata yang memerlukan tiket masuk, berikan estimasi harga tiket untuk 1 orang dalam format string (contoh: "Rp 15.000"). Jika gratis, kembalikan string "Gratis". Jika tidak ada informasi harga yang jelas di review, kembalikan string kosong "". Hanya kembalikan string hasilnya, tanpa penjelasan tambahan.`,
                            },
                        ],
                    },
                ];
                const hargaResponse = await ai.models.generateContentStream({
                    model,
                    config,
                    contents: hargaContents,
                });
                let hargaText = "";
                for await (const chunk of hargaResponse) {
                    hargaText += chunk.text || "";
                }
                harga = hargaText.trim().replace(/^"|"$/g, "");

                const deskripsiContents = [
                    {
                        role: "user",
                        parts: [
                            {
                                text: `Berdasarkan nama tempat "${nama}", alamat "${alamat}", dan review berikut: ${ulasans.map((u) => u.ulasan).join(" ")}. Buatkan deskripsi singkat dan menarik tentang tempat ini dalam 2-3 kalimat yang menggambarkan keunikan dan daya tariknya.`,
                            },
                        ],
                    },
                ];
                const deskripsiResponse = await ai.models.generateContentStream({
                    model,
                    config,
                    contents: deskripsiContents,
                });
                for await (const chunk of deskripsiResponse) {
                    deskripsi += chunk.text || "";
                }
                deskripsi = deskripsi.trim();
                break;
            } catch (error: any) {
                if (error.message && error.message.includes("429")) {
                    console.log("Rate limit exceeded. Waiting 25 seconds before retrying...");
                    await new Promise((resolve) => setTimeout(resolve, 25000));
                    console.log(`Retrying ${nama}...`);
                    continue;
                } else {
                    console.log(`Proses dihentikan karena error pada data: ${nama}`);
                    break;
                }
            }
        }

        return { harga, deskripsi };
    }

    private async isVisible(selector: string): Promise<boolean> {
        if (!this.page) return false;
        return await this.page.$eval(selector, (el) => (el as HTMLElement).offsetHeight > 0 && window.getComputedStyle(el).display !== "none");
    }

    private async extractSinglePlaceInfo(): Promise<{
        nama1: string;
        alamat: string;
    }> {
        await this.page!.waitForNetworkIdle({ concurrency: 7 });
        const selector = 'div[role="main"]';
        await this.page!.waitForSelector(`${selector} h1`, { visible: true });
        const nama1 = await this.page!.$eval(`${selector} h1`, (el) => el.textContent?.trim() || "");

        let alamat = "";
        try {
            alamat = await this.page!.$eval(`${selector} div.Io6YTe`, (el) => el.textContent?.trim() || "");
        } catch (e) {
            this.log(`⚠️ Alamat tidak ditemukan`);
        }

        return { nama1, alamat };
    }

    private log(message: string, data?: any): void {
        const timestamp = new Date().toLocaleTimeString();
        if (data) {
            console.log(`[${timestamp}] ${message}`);
            console.log(data);
        } else {
            console.log(`[${timestamp}] ${message}`);
        }
    }

    private extractCoordinates(url: string): {
        latitude: number;
        longitude: number;
    } {
        const match = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
        return {
            latitude: parseFloat(match?.[1] || "0"),
            longitude: parseFloat(match?.[2] || "0"),
        };
    }

    private async savePlaceToDatabase(data: { nama: string; slug: string; alamat: string; latitude: number; longitude: number; map_url: string; deskripsi: string; ulasans: any[] }): Promise<void> {
        const info = await prisma.transportationMaps.upsert({
            where: { nama: data.nama },
            update: {
                slug: data.slug,
                alamat: data.alamat,
                latitude: data.latitude,
                longitude: data.longitude,
                map_url: data.map_url,
                deskripsi: data.deskripsi,
                reviews: {
                    create: data.ulasans.map((u: any) => ({
                        nama: u.nama || "",
                        komentar: u.ulasan || "",
                        tanggal: u.tanggal || "",
                    })),
                },
            },
            create: {
                nama: data.nama,
                slug: data.slug,
                alamat: data.alamat,
                latitude: data.latitude,
                longitude: data.longitude,
                map_url: data.map_url,
                deskripsi: data.deskripsi,
                reviews: {
                    create: data.ulasans.map((u: any) => ({
                        nama: u.nama || "",
                        komentar: u.ulasan || "",
                        tanggal: u.tanggal || "",
                    })),
                },
            },
        });
        console.log(info);
    }

    public async getDetails(search: string, saveToDB: boolean, geminiApiKey?: string): Promise<void> {
        try {
            this.log(`🚀 Memulai pencarian untuk: "${search}"`);
            const browser = await this.initBrowser();
            this.page = await browser.newPage();

            // await this.page.setRequestInterception(true);

            // this.page.on("request", (req) => {
            // 	const url = req.url();
            // 	const resourceType = req.resourceType();

            // 	if (url.includes("/maps/vt/") || resourceType === "font") {
            // 		req.abort();
            // 	} else {
            // 		req.continue();
            // 	}
            // });

            await this.page.goto("https://www.google.com/maps?hl=en");
            this.log("📍 Navigasi ke Google Maps");
            await this.page.type("input[name='q']", search);
            await this.page.keyboard.press("Enter");
            this.log("⌨️  Input search query dan Enter");

            try {
                await this.page.waitForFunction(() => document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"] h1'), { timeout: 10000 });
            } catch (e) {
                this.log("⚠️ Timeout waiting for search results to appear");
            }

            let isFeed = !!(await this.page.$(`div[role="feed"]`));
            this.log(`ℹ️  Mode tampilan: ${isFeed ? "List (Feed)" : "Single Result"}`);

            if (isFeed) {
                const isEndVisible = async () => {
                    return this.page?.evaluate(() => {
                        return new Promise((resolve) => {
                            const el = document.querySelector("span.HlvSq");
                            if (!el) return resolve(false);

                            const observer = new IntersectionObserver((entries) => {
                                resolve(entries[0].isIntersecting);
                                observer.disconnect();
                            });

                            observer.observe(el);
                        });
                    });
                };

                while (!(await isEndVisible())) {
                    const items = await this.page.$$(`div[role="feed"] > div`);

                    for (const item of items) {
                        const isProcessed = await item.evaluate((el) => el.dataset._done === "1");
                        if (isProcessed) continue;
                        await item.evaluate((el) => (el.dataset._done = "1"));

                        const aTag = await item.$("div > div > a");
                        if (!aTag) continue;

                        await aTag.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));

                        let nama1 = await item.$eval(`div > div .fontHeadlineSmall`, (el) => el.textContent?.trim());
                        this.log(`🔎 Memeriksa item: ${nama1}`);
                        if (saveToDB && nama1) {
                            const slugs = slug(nama1, { lower: true });
                            const existingPlace = await prisma.transportationMaps.findUnique({
                                where: { slug: slugs },
                            });
                            if (existingPlace) {
                                this.log(`⏭️  Tempat "${nama1}" sudah ada di database, diskip.`);
                                continue;
                            }
                        }

                        const aTagClicked = await this.repeatClickUntilSuccess(this.page, aTag);
                        if (!aTagClicked) {
                            this.log(`❌ Gagal mengklik item: ${nama1}`);
                            continue;
                        }
                        this.log(`🖱️  Berhasil klik item: ${nama1}`);

                        if (!(await this.isVisible('div[role="feed"]'))) {
                            this.log("Single place info:", await this.extractSinglePlaceInfo());
                            return;
                        }

                        await this.page.waitForNetworkIdle({ concurrency: 7 });

                        await this.page.waitForSelector('div[role="main"] div.Io6YTe', { visible: true });
                        const { nama, alamat } = await this.extractBasicInfo(this.page, 'div[role="main"]');
                        this.log(`📄 Info dasar diekstrak: ${nama1}`);

                        // Validasi data dasar
                        if (!nama || !alamat) {
                            this.log(`⚠️  Data tidak lengkap untuk item ini, skip.`);
                            await this.page.click(`svg.NMm5M`);
                            await this.page.waitForNetworkIdle({ concurrency: 7 });
                            continue;
                        }

                        try {
                            this.log(`⭐ Memulai ekstraksi review untuk: ${nama1}`);
                            let { ulasans } = await this.extractReviews('div[role="main"]');
                            this.log(`✅ Review diekstrak: ${ulasans.length} ulasan`);

                            this.log(`🤖 Menggenerate konten AI untuk: ${nama1}`);

                            let { harga, deskripsi } = await this.generateAIContent(nama1, alamat, ulasans, geminiApiKey);

                            // Generate slug from nama
                            const generatedSlug = slug(nama1, { lower: true });

                            // Logging data
                            this.log(`🔄 Processing: ${nama1}`);

                            const { latitude, longitude } = this.extractCoordinates(this.page.url());

                            if (saveToDB) {
                                await this.savePlaceToDatabase({
                                    nama: nama1,
                                    slug: generatedSlug,
                                    alamat,
                                    latitude,
                                    longitude,
                                    map_url: this.page.url(),
                                    deskripsi,
                                    ulasans,
                                });
                                this.log(`✅ Data "${nama1}" berhasil disimpan ke DB.`);
                            }
                        } catch (error) {
                            this.log(`❌ Gagal memproses ulasan untuk "${nama1}". Melanjutkan ke item berikutnya.`);
                            continue;
                        }

                        await this.page.waitForSelector("div.hWERUb:nth-child(3) > span:nth-child(1) > button:nth-child(1)", { visible: true });
                        await this.page.click("div.hWERUb:nth-child(3) > span:nth-child(1) > button:nth-child(1)");

                        await this.page.waitForNetworkIdle({ concurrency: 7 });
                        await this.page.waitForSelector(`.BHymgf`, { hidden: true });
                    }
                }
            } else {
                // Single Result Case
                this.log("👤 Memproses Single Result...");
                const { nama1, alamat } = await this.extractSinglePlaceInfo();
                this.log(`📄 Info dasar diekstrak: ${nama1}`);

                if (saveToDB && nama1) {
                    const slugs = slug(nama1, { lower: true });
                    const existingPlace = await prisma.transportationMaps.findUnique({
                        where: { slug: slugs },
                    });
                    if (existingPlace) {
                        this.log(`⏭️  Tempat "${nama1}" sudah ada di database, proses dihentikan.`);
                        return;
                    }
                }

                let rating = "";
                let ulasans: any[] = [];

                try {
                    this.log(`⭐ Memulai ekstraksi review untuk: ${nama1}`);
                    const result = await this.extractReviews('div[role="main"]');
                    rating = result.rating;
                    ulasans = result.ulasans;
                    this.log(`✅ Review diekstrak: ${ulasans.length} ulasan`);
                } catch (error) {
                    this.log(`❌ Gagal memproses ulasan untuk "${nama1}". Menghentikan proses untuk item ini.`);
                    return;
                }

                this.log(`🤖 Menggenerate konten AI untuk: ${nama1}`);
                let deskripsi: string = "";

                while (true) {
                    try {
                        const ai = new GoogleGenAI({
                            apiKey: geminiApiKey || process.env.GEMINI_API_KEY,
                        });
                        const config = { responseMimeType: "text/plain" };
                        const model = "gemini-2.5-flash-preview-05-20";
                        const hargaContents = [
                            {
                                role: "user",
                                parts: [
                                    {
                                        text: `Berdasarkan nama tempat "${nama1}" dan review berikut: ${ulasans
                                            .map((u) => u.ulasan)
                                            .join(" ")}. Jika ini adalah tempat wisata yang memerlukan tiket masuk, berikan estimasi harga tiket untuk 1 orang dalam format string (contoh: "Rp 15.000"). Jika gratis, kembalikan string "Gratis". Jika tidak ada informasi harga yang jelas di review, kembalikan string kosong "". Hanya kembalikan string hasilnya, tanpa penjelasan tambahan.`,
                                    },
                                ],
                            },
                        ];

                        const deskripsiContents = [
                            {
                                role: "user",
                                parts: [
                                    {
                                        text: `Berdasarkan nama tempat "${nama1}", alamat "${alamat}", dan review berikut: ${ulasans.map((u) => u.ulasan).join(" ")}. Buatkan deskripsi singkat dan menarik tentang tempat ini dalam 2-3 kalimat.`,
                                    },
                                ],
                            },
                        ];
                        const deskripsiResponse = await ai.models.generateContentStream({
                            model,
                            config,
                            contents: deskripsiContents,
                        });
                        for await (const chunk of deskripsiResponse) {
                            deskripsi += chunk.text || "";
                        }
                        deskripsi = deskripsi.trim();
                        break;
                    } catch (error: any) {
                        // Check if it's a rate limit error (429)
                        if (error.message && error.message.includes("429")) {
                            this.log("⏰ Rate limit exceeded. Menunggu 25 detik sebelum retry...");
                            await new Promise((resolve) => setTimeout(resolve, 25000));
                            this.log(`🔄 Retry untuk "${nama1}"...`);
                            continue; // Retry the same data
                        } else {
                            this.log(`❌ Proses dihentikan karena error pada data: ${nama1}`);
                            break;
                        }
                    }
                }

                // Generate slug dari nama
                const generatedSlug = slug(nama1 || "", { lower: true });

                // Logging data
                this.log(`🔄 Processing: ${nama1}`, {
                    slug: generatedSlug,
                    alamat,
                    deskripsi,
                    reviews: ulasans[0],
                });

                const { latitude, longitude } = this.extractCoordinates(this.page.url());

                if (saveToDB) {
                    await this.savePlaceToDatabase({
                        nama: nama1 || "",
                        slug: generatedSlug,
                        alamat: alamat || "",
                        latitude,
                        longitude,
                        map_url: this.page.url(),
                        deskripsi: deskripsi || "",
                        ulasans,
                    });
                    this.log(`✅ Data "${nama1}" berhasil disimpan ke DB.`);
                }
            }
        } catch (error) {
            this.log(`❌ Error: ${error}`);
        } finally {
            if (!this.page) return;
            await this.page.close();
            this.log("✋ Tab ditutup.");
        }
    }
}
