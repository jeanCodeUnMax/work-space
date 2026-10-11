"""Everything-compatible filter categories (extension sets)."""

CATEGORIES: dict[str, list[str]] = {
    "audio": "aac ac3 aif aifc aiff ape au cda dts fla flac it m1a m2a m3u m4a mid midi mka mod mp2 mp3 mpa ogg ra rmi s3m snd spx umx voc wav wma xm".split(),
    "compressed": "7z ace arj bz2 cab gz gzip iso lzh pak rar rev sit tgz uu uue xxe z zip".split(),
    "document": "c chm cpp csv cxx db dbf doc docx htm html ini log md mht msg ods odt pdf pps ppt pptx ps pub rpt rtf srt tex tsv txt vsd wpd wps wri xhtml xls xlsx xml xsl".split(),
    "executable": "app bat bats cmd com cpl dll exe gadget inf1 ins inx isu jar jse job lnk msc msi msix msp paf pif ps1 py reg rgs scr sct shb shs u3p vb vbe vbs vbscript ws wsf wsh".split(),
    "picture": "ani bmp cur emf gif ico jpeg jpg pcx png psd svg tga tif tiff webp wmf".split(),
    "video": "3g2 3gp 3gp2 3gpp amr asf asx avi bdmv bik d2v divx drc dsm dsf dss dts evo f4v flc fli flic flv hdm hdv ifo ivf m1v m2p m2s m2t m2ts m2v m4v mk3d mkv mov mp2v mp4 mpe mpeg mpg mpls mpv mpv2 mts ogm ogv pjs pss pva qt ram ratdvd rm rmm rms rmvb roq rp rpl rt smi smil smk swf tivo tp trp ts vcd vdr vid video vob vp6 vp7 vtt w64 webm wm wmp wmv wmx wvx xvid".split(),
}

# alias category keywords Everything accepts
CATEGORY_ALIASES = {
    "audio": "audio",
    "music": "audio",
    "zip": "compressed",
    "compressed": "compressed",
    "archive": "compressed",
    "doc": "document",
    "document": "document",
    "exe": "executable",
    "executable": "executable",
    "pic": "picture",
    "picture": "picture",
    "image": "picture",
    "video": "video",
}


def extensions_for(category: str) -> list[str] | None:
    return CATEGORIES.get(CATEGORY_ALIASES.get(category.lower(), category.lower()))
