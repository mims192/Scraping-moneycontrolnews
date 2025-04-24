import puppeteer from 'puppeteer';
import express from "express";
import axios from 'axios';
import dotenv from 'dotenv';


dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;



app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

const CONFIG = {
  groqApiKey: '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',
  apiDelay: 30000,
  nsePattern: /^NSE:[A-Z0-9]{2,10}$/i,
  wpApiUrl: 'https://profitbooking.in/wp-json/scraper/v1/moneycontrol'
};


const scrapeStocksToWatch = async () => {
  const browser = await puppeteer.launch({ headless: false }); // Run in non-headless mode for debugging
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
  });

  try {
      await page.goto('https://www.moneycontrol.com/news/tags/stocks-to-watch.html', { waitUntil: 'networkidle2', timeout: 120000 });
      await page.waitForSelector('#newslist-0 h2 a', { timeout: 10000 }); 
  
      const articleUrl = await page.evaluate(() => {
          const firstAnchor = document.querySelector('#newslist-0 h2 a');
          return firstAnchor ? firstAnchor.href : null;
      });

      console.log(` Found Article: ${articleUrl}`);
     
      if (articleUrl) {
          const articlePage = await browser.newPage();
          await articlePage.goto(articleUrl);
         
          const data = await articlePage.evaluate(() => {
              const allP = Array.from(document.querySelectorAll('p'));
              const result = [];
              let currentCompany = null;
              
              
              allP.forEach(p => {
                  const strong = p.querySelector('strong');   
                  const link = p.querySelector('a');

                  if (strong && link) {
                      if (currentCompany) result.push(currentCompany);
                      currentCompany = {
                          title: strong.innerText.trim(),
                          content: []
                      };
                  } else if (currentCompany) {
                      const text = p.innerText.trim();
                      if (text) currentCompany.content.push({ point: text });
                  }
              });

              if (currentCompany) result.push(currentCompany);
              return result;
          });

          console.log('Article Data:', data);

          let lastApiCall = 0;
          for (const item of data) {
            console.log(`Validating "${item.title}" with Groq...`);
        
            const now = Date.now();
            if (now - lastApiCall < CONFIG.apiDelay) {
              const delay = CONFIG.apiDelay - (now - lastApiCall);
              console.log(` Waiting ${delay}ms (rate limiting)...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
        
            const groqResponse = await queryGroq(item.title);
            console.log(groqResponse)
            lastApiCall = Date.now();
            if (!groqResponse) {
              console.warn(` Skipping "${item.title}" — Groq returned null.`);
              continue;
            }
            if (groqResponse?.isValid && CONFIG.nsePattern.test(groqResponse.nsc || '')) {
              console.log(`NSE LISTED: ${item.title} → ${groqResponse.nsc}`);
            } else {
              console.log(`Not NSE listed: ${item.title}`);
            }
        
            console.log('---------------------------');
 

            
              const wpData = {
                headline: item.title,
                conclusion: item.content.map(p => p.point).join('\n'), // Join content points into a single string
                company:  groqResponse.isValid ? groqResponse.nsc : null // Use the stock name returned by Groq
              };

              // Store in WordPress
              const stored = await storeInWordPress(wpData);
              if (stored) {
                console.log(`Successfully stored "${item.title}" in WordPress.`);

              }else if(stored?.duplicate){
                console.log(` Skipped duplicate: "${item.title}"`);
              }
              else {
                console.log(`Failed to store "${item.title}" in WordPress.`);
              }
             console.log(item.title)
             console.log(item.content.map(p => p.point).join('\n'))
             console.log(groqResponse.nsc)

              
        
            console.log('---------------------------');
          
            
          }
        
          await articlePage.close();
      } else {
          console.log('No article found.');
      }
  } catch (error) {
      console.error('Error fetching data:', error);
      return null;
  } finally {
      await browser.close();
  }
};
async function storeInWordPress(data) {
  try {
    const response = await axios.post(CONFIG.wpApiUrl, {
      title: data.headline,
      content: data.conclusion,
      company: data.company,
      created_at: new Date().toISOString()
     
    });

    console.log('Stored in WordPress:', response.data);
    return true;
  } catch (error) {
    console.error('WP API Error:', error.response?.data || error.message);
    return false;
  }
}


async function queryGroq(text) {
  try {
    
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'deepseek-r1-distill-llama-70b',
        messages: [
          {
            role: 'user',
            content: `Extract NSE-listed company info in this JSON format only. Respond ONLY with valid JSON:
{
  "company_name": "string|null",
  "nsc": "string|null",
  "confidence": "number|null",
  
}

Example valid response for NSE company: 
{"company_name": "Reliance Industries", "nsc": "NSE:RELIANCE", "confidence": 0.92}
Example null response: 
{"company_name": null, "nsc": null, "confidence": null}
Headline: ${text.substring(0, 1000)}`
          }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.groqApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    
    const message = response.data.choices[0]?.message?.content;
    console.log("Groq Raw Content:", message);

    const parsed = JSON.parse(message);

    const { company_name, nsc, confidence } = parsed;

    const isValid =
      (typeof company_name === 'string' || company_name === null) &&
      (typeof nsc === 'string' || nsc === null) &&
      (typeof confidence === 'number' || confidence === null) 
     

    return {
      company_name,
      nsc,
      confidence,
    
      isValid,
      raw: nsc,
    };

  } catch (error) {
    console.error('Groq API error:', error.response?.data?.error?.code || error.code);
    return null;
  }
}

scrapeStocksToWatch();