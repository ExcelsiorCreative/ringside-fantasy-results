<collection checked="{{.Metadata.datetimeRFC3339}}">
{{range .Feeds}}<feed source="{{.FeedLink}}" channel="{{.Link}}" title="{{.Title}}">{{range .Items}}
<video href="{{.Link}}" published="{{.Published}}"><title>{{.Title}}</title></video>
{{end}}</feed>{{end}}
</collection>
