package main

import (
	"fmt"
	"log"

	"github.com/gocolly/colly"
)

type Book struct {
	Title  string
	Price  string
	Rating string
}

func main() {
	c := colly.NewCollector()
	books := []Book{}

	c.OnHTML(".product_pod", func(e *colly.HTMLElement) {
		book := Book{
			Title:  e.ChildText("h3 a"),
			Price:  e.ChildText(".price_color"),
			Rating: e.ChildAttr("p", "class"),
		}
		books = append(books, book)
	})

	c.OnScraped(func(_ *colly.Response) {
		fmt.Println("✔ Done scraping")
		for _, b := range books {
			fmt.Printf("Title: %s | Price: %s | Rating: %s\n", b.Title, b.Price, b.Rating)
		}
	})

	err := c.Visit("http://books.toscrape.com/")
	if err != nil {
		log.Fatal(err)
	}
}
