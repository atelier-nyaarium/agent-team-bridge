FROM oven/bun:1

ENV DEBIAN_FRONTEND=noninteractive

RUN apt update && apt install -y locales tzdata && apt clean -y && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen en_US.UTF-8 \
    && update-locale LANG=en_US.UTF-8 \
    && ln -fs /usr/share/zoneinfo/America/Los_Angeles /etc/localtime \
    && echo "America/Los_Angeles" > /etc/timezone
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# General development tools
RUN apt update && apt install -y \
	bash-completion \
	curl \
	gcc \
	git \
	gpg \
	htop \
	iftop \
	jq \
	less \
	lsof \
	make \
	man \
	ncdu \
	neovim \
	net-tools \
	openssl \
	procps \
	rsync \
	screen \
	slurm \
	sudo \
	tmux \
	tree \
	unzip \
	uuid \
	vim \
	wget \
	yq \
	zip \
	&& apt autoremove --purge -y \
	&& apt clean -y && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
	&& apt update && apt install -y gh \
	&& apt clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
# Install runs the postinstall, which links nothing without lexicon/ in the image.
COPY scripts/link-lexicon.mjs scripts/
RUN bun install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./

CMD ["bun", "run", "src/main-gateway.ts"]
